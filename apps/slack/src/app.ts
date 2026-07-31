import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import {
  deriveIngressIds,
  IngressFailure,
  startStandardIngress,
  T3TransportError,
  type IngressInvocation,
  type T3Transport,
} from "@t3tools/integration-runtime";
import * as Effect from "effect/Effect";

import type { SlackAppConfig } from "./config.ts";
import { normalizeMentionInvocation, normalizeSlashInvocation } from "./invocation.ts";

export const SLACK_COMMAND = "/t3";
export const SLACK_METADATA_EVENT_TYPE = "t3_ingress_v1";

const failureText = (error: unknown, publicBaseUrl: string): string => {
  if (error instanceof IngressFailure) return error.message;
  if (error instanceof T3TransportError) {
    if (error.kind === "authentication" || error.kind === "authorization") {
      return "T3 Code is not authorized. Ask an administrator to check the integration credential.";
    }
  }
  return `T3 Code could not be reached. Open ${publicBaseUrl}`;
};

const runIngress = (input: {
  readonly invocation: IngressInvocation;
  readonly config: SlackAppConfig;
  readonly transport: T3Transport;
}) =>
  Effect.runPromise(
    startStandardIngress({
      request: {
        invocation: input.invocation,
        target: {
          projectId: input.config.projectId,
          modelSelection: input.config.modelSelection,
        },
        requestedAt: new Date().toISOString(),
      },
      publicBaseUrl: input.config.t3PublicBaseUrl,
      transport: input.transport,
    }),
  );

export async function handleSlashCommand(input: {
  readonly teamId: string;
  readonly responseUrl: string;
  readonly text: string;
  readonly publicBaseUrl: string;
  readonly ack: (message: {
    readonly response_type: "ephemeral";
    readonly text: string;
  }) => Promise<void>;
  readonly respond: (message: {
    readonly replace_original: true;
    readonly response_type: "ephemeral";
    readonly text: string;
  }) => Promise<void>;
  readonly start: (invocation: IngressInvocation) => Promise<{
    readonly recovery: string;
    readonly deepLink: string;
  }>;
}): Promise<void> {
  const invocation = normalizeSlashInvocation({
    teamId: input.teamId,
    responseUrl: input.responseUrl,
    text: input.text,
  });
  if (!invocation.prompt) {
    await input.ack({ response_type: "ephemeral", text: "Usage: /t3 <prompt>" });
    return;
  }
  await input.ack({ response_type: "ephemeral", text: "Starting in T3 Code..." });
  let result: Awaited<ReturnType<typeof input.start>>;
  try {
    result = await input.start(invocation);
  } catch (error) {
    await input.respond({
      replace_original: true,
      response_type: "ephemeral",
      text: failureText(error, input.publicBaseUrl),
    });
    return;
  }
  await input.respond({
    replace_original: true,
    response_type: "ephemeral",
    text:
      result.recovery === "unverified"
        ? `T3 Code could not verify whether the conversation started. Open ${input.publicBaseUrl}`
        : `<${result.deepLink}|Open in T3 Code>`,
  });
}

interface MentionMessageBase {
  readonly channel: string;
  readonly text: string;
  readonly metadata?: {
    readonly event_type: typeof SLACK_METADATA_EVENT_TYPE;
    readonly event_payload: { readonly thread_id: string; readonly message_id: string };
  };
}
interface MentionPostMessage extends MentionMessageBase {
  readonly thread_ts: string;
}
interface MentionUpdateMessage extends MentionMessageBase {
  readonly ts: string;
}

export async function handleMentionEvent(input: {
  readonly teamId: string;
  readonly channelId: string;
  readonly botUserId: string;
  readonly eventId: string;
  readonly messageTimestamp: string;
  readonly parentThreadTimestamp?: string;
  readonly text: string;
  readonly publicBaseUrl: string;
  readonly postMessage: (message: MentionPostMessage) => Promise<{ readonly ts?: string }>;
  readonly updateMessage: (message: MentionUpdateMessage) => Promise<unknown>;
  readonly warn: (category: string, threadId?: string) => void;
  readonly start: (invocation: IngressInvocation) => Promise<{
    readonly recovery: string;
    readonly deepLink: string;
  }>;
}): Promise<void> {
  const invocation = normalizeMentionInvocation({
    teamId: input.teamId,
    channelId: input.channelId,
    botUserId: input.botUserId,
    eventId: input.eventId,
    messageTimestamp: input.messageTimestamp,
    text: input.text,
  });
  if (!invocation.prompt) {
    /* oxlint-disable unicorn/require-post-message-target-origin -- Slack Web API callback, not Window.postMessage. */
    await input.postMessage({
      channel: input.channelId,
      thread_ts: input.parentThreadTimestamp ?? input.messageTimestamp,
      text: "Mention me with a prompt to start a T3 Code conversation.",
    });
    /* oxlint-enable unicorn/require-post-message-target-origin */
    return;
  }
  const ids = deriveIngressIds(invocation);
  const metadata = {
    event_type: SLACK_METADATA_EVENT_TYPE,
    event_payload: { thread_id: ids.threadId, message_id: ids.messageId },
  } as const;
  /* oxlint-disable unicorn/require-post-message-target-origin -- Slack Web API callback, not Window.postMessage. */
  const starting = await input.postMessage({
    channel: input.channelId,
    thread_ts: input.parentThreadTimestamp ?? input.messageTimestamp,
    text: "Starting in T3 Code...",
    metadata,
  });
  /* oxlint-enable unicorn/require-post-message-target-origin */
  if (!starting.ts) {
    input.warn("starting_message_missing_timestamp", ids.threadId);
    return;
  }
  let result: Awaited<ReturnType<typeof input.start>>;
  try {
    result = await input.start(invocation);
  } catch (error) {
    await input.updateMessage({
      channel: input.channelId,
      ts: starting.ts,
      text: failureText(error, input.publicBaseUrl),
    });
    return;
  }
  await input.updateMessage({
    channel: input.channelId,
    ts: starting.ts,
    text:
      result.recovery === "unverified"
        ? `T3 Code could not verify whether the conversation started. Open ${input.publicBaseUrl}`
        : `<${result.deepLink}|Open in T3 Code>`,
    metadata,
  });
}

export function makeSlackApp(input: {
  readonly config: SlackAppConfig;
  readonly transport: T3Transport;
}): { readonly app: App; readonly receiver: SocketModeReceiver } {
  const receiver = new SocketModeReceiver({
    appToken: input.config.slackAppToken,
    logLevel: LogLevel.INFO,
    autoReconnectEnabled: true,
  });
  const app = new App({
    token: input.config.slackBotToken,
    receiver,
    logLevel: LogLevel.INFO,
  });
  const startWithLogging = async (invocation: IngressInvocation) => {
    const { threadId } = deriveIngressIds(invocation);
    app.logger.info("slack.ingress.started", { surface: invocation.surface, threadId });
    try {
      const result = await runIngress({ invocation, ...input });
      app.logger.info("slack.ingress.completed", {
        surface: invocation.surface,
        threadId,
        recovery: result.recovery,
      });
      return result;
    } catch (error) {
      app.logger.warn("slack.ingress.failed", {
        surface: invocation.surface,
        threadId,
        category:
          error instanceof IngressFailure
            ? error.code
            : error instanceof T3TransportError
              ? error.kind
              : "unexpected",
      });
      throw error;
    }
  };

  app.command(SLACK_COMMAND, async ({ ack, command, respond }) => {
    await handleSlashCommand({
      teamId: command.team_id,
      responseUrl: command.response_url,
      text: command.text,
      publicBaseUrl: input.config.t3PublicBaseUrl,
      ack: async (message) => {
        await ack(message);
      },
      respond: async (message) => {
        await respond(message);
      },
      start: startWithLogging,
    });
  });

  app.event("app_mention", async ({ event, body, client, context }) => {
    const mention = event;
    const botUserId = context.botUserId ?? body.authorizations?.[0]?.user_id;
    if (!botUserId) {
      app.logger.warn("slack.ingress.rejected", {
        surface: "mention",
        category: "bot_identity_missing",
      });
      return;
    }
    await handleMentionEvent({
      teamId: body.team_id,
      channelId: mention.channel,
      botUserId,
      eventId: body.event_id,
      messageTimestamp: mention.ts,
      ...(mention.thread_ts === undefined ? {} : { parentThreadTimestamp: mention.thread_ts }),
      text: mention.text,
      publicBaseUrl: input.config.t3PublicBaseUrl,
      postMessage: async (message) => {
        /* oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack Web API method, not Window.postMessage. */
        return client.chat.postMessage(message);
      },
      updateMessage: (message) => client.chat.update(message),
      warn: (category, threadId) =>
        app.logger.warn("slack.ingress.rejected", { surface: "mention", category, threadId }),
      start: startWithLogging,
    });
  });

  return { app, receiver };
}
