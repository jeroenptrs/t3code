import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import {
  deriveIngressIds,
  IngressFailure,
  makeShellProjection,
  startCustomIngress,
  startStandardIngress,
  T3TransportError,
  type IngressInvocation,
  type T3Transport,
} from "@t3tools/integration-runtime";
import * as Effect from "effect/Effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import type { SlackAppConfig } from "./config.ts";
import { makeAppHomePublisher, resolveAppHomeOpenSnapshot } from "./appHome.ts";
import {
  normalizeCustomMentionInvocation,
  normalizeCustomSlashInvocation,
  normalizeDirectMessageInvocation,
  normalizeMentionInvocation,
  normalizeSlashInvocation,
  isCustomMentionPrompt,
} from "./invocation.ts";
import {
  branchSlackOptions,
  buildLoadingSetupView,
  buildSetupErrorView,
  buildSetupView,
  loadBranchCatalog,
  loadSetupCatalog,
  loadModelOptions,
  loadProjectOptions,
  modelSlackOptionGroups,
  projectSlackOptions,
  SETUP_BRANCH_ACTION,
  SETUP_CALLBACK_ID,
  SETUP_CONFIGURE_ACTION,
  SETUP_MODEL_ACTION,
  SETUP_PROJECT_ACTION,
  SETUP_PROMPT_ACTION,
  SETUP_WORKSPACE_ACTION,
  SLACK_PROMPT_MAX_LENGTH,
  type SetupOrigin,
} from "./setup.ts";

export const SLACK_COMMAND = "/t3";
export const SLACK_CUSTOM_COMMAND = "/t3-custom";
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

const canConfigureFailure = (error: unknown): error is IngressFailure =>
  error instanceof IngressFailure &&
  (error.code === "project_not_found" || error.code === "model_unavailable");

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

type SetupStateValues = Record<
  string,
  Record<string, { readonly value?: string; readonly selected_option?: { readonly value: string } }>
>;

const stateValue = (values: SetupStateValues, actionId: string): string | null => {
  for (const block of Object.values(values)) {
    const action = block[actionId];
    const value = action?.selected_option?.value ?? action?.value;
    if (typeof value === "string") return value;
  }
  return null;
};

interface ConfigurePayload {
  readonly origin: SetupOrigin;
  readonly prompt: string;
}

const parseJson = <A>(value: string): A => JSON.parse(value) as A;

const invocationWithoutPrompt = (
  invocation: IngressInvocation,
): Omit<IngressInvocation, "prompt"> => {
  const { prompt: _prompt, ...identity } = invocation;
  return identity;
};

export const promptValidationMessage = (prompt: string): string | null => {
  if (!prompt.trim()) return "Include a prompt to configure a T3 Code conversation.";
  if (prompt.length > SLACK_PROMPT_MAX_LENGTH) {
    return `Prompts must be ${SLACK_PROMPT_MAX_LENGTH.toLocaleString()} characters or fewer.`;
  }
  return null;
};

const configureBlocks = (origin: SetupOrigin, prompt: string) => [
  {
    type: "section",
    block_id: "t3_setup_prompt_preview",
    text: { type: "plain_text", text: prompt },
  },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: SETUP_CONFIGURE_ACTION,
        text: { type: "plain_text", text: "Configure" },
        value: JSON.stringify(origin),
      },
    ],
  },
];

const withSlackOptionsDeadline = <A>(load: Promise<A>, fallback: A): Promise<A> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), 2_000);
    load.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });

const promptFromActionBody = (rawBody: unknown): string | null => {
  if (!rawBody || typeof rawBody !== "object" || !("message" in rawBody)) return null;
  const message = rawBody.message;
  if (!message || typeof message !== "object" || !("blocks" in message)) return null;
  if (!Array.isArray(message.blocks)) return null;
  for (const block of message.blocks) {
    if (
      block &&
      typeof block === "object" &&
      "block_id" in block &&
      block.block_id === "t3_setup_prompt_preview" &&
      "text" in block &&
      block.text &&
      typeof block.text === "object" &&
      "text" in block.text &&
      typeof block.text.text === "string"
    ) {
      return block.text.text;
    }
  }
  return null;
};

export async function handleSlashCommand(input: {
  readonly teamId: string;
  readonly responseUrl: string;
  readonly text: string;
  readonly publicBaseUrl: string;
  readonly ack: (message?: {
    readonly response_type: "ephemeral";
    readonly text: string;
  }) => Promise<void>;
  readonly respond: (message: {
    readonly replace_original: true;
    readonly response_type: "ephemeral";
    readonly text: string;
    readonly blocks?: ReadonlyArray<object>;
  }) => Promise<void>;
  readonly failureMessage?: (
    error: unknown,
    invocation: IngressInvocation,
  ) => { readonly text: string; readonly blocks?: ReadonlyArray<object> } | null;
  readonly start: (invocation: IngressInvocation) => Promise<{
    readonly recovery: string;
    readonly deepLink: string;
  }>;
  readonly postVisible?: (message: {
    readonly text: string;
    readonly metadata: {
      readonly event_type: typeof SLACK_METADATA_EVENT_TYPE;
      readonly event_payload: { readonly thread_id: string; readonly message_id: string };
    };
  }) => Promise<{ readonly ts?: string }>;
  readonly updateVisible?: (message: {
    readonly ts: string;
    readonly text: string;
    readonly metadata?: {
      readonly event_type: typeof SLACK_METADATA_EVENT_TYPE;
      readonly event_payload: { readonly thread_id: string; readonly message_id: string };
    };
    readonly blocks?: ReadonlyArray<object>;
  }) => Promise<unknown>;
}): Promise<void> {
  await input.ack();
  const invocation = normalizeSlashInvocation({
    teamId: input.teamId,
    responseUrl: input.responseUrl,
    text: input.text,
  });
  if (!invocation.prompt) {
    await input.respond({
      replace_original: true,
      response_type: "ephemeral",
      text: "Usage: /t3 <prompt>",
    });
    return;
  }
  const ids = deriveIngressIds(invocation);
  const metadata = {
    event_type: SLACK_METADATA_EVENT_TYPE,
    event_payload: { thread_id: ids.threadId, message_id: ids.messageId },
  } as const;
  const visibleMessage = await input.postVisible?.({
    text: "Starting in T3 Code...",
    metadata,
  });
  let result: Awaited<ReturnType<typeof input.start>>;
  try {
    result = await input.start(invocation);
  } catch (error) {
    const configuredFailure = input.failureMessage?.(error, invocation);
    if (visibleMessage?.ts && input.updateVisible) {
      await input.updateVisible({
        ts: visibleMessage.ts,
        text: configuredFailure?.text ?? failureText(error, input.publicBaseUrl),
        ...(configuredFailure?.blocks ? { blocks: configuredFailure.blocks } : {}),
      });
      return;
    }
    await input.respond({
      replace_original: true,
      response_type: "ephemeral",
      text: configuredFailure?.text ?? failureText(error, input.publicBaseUrl),
      ...(configuredFailure?.blocks ? { blocks: configuredFailure.blocks } : {}),
    });
    return;
  }
  const terminalText =
    result.recovery === "unverified"
      ? `T3 Code could not verify whether the conversation started. Open ${input.publicBaseUrl}`
      : `Open in T3 Code: ${result.deepLink}`;
  if (visibleMessage?.ts && input.updateVisible) {
    await input.updateVisible({ ts: visibleMessage.ts, text: terminalText, metadata });
    return;
  }
  await input.respond({
    replace_original: true,
    response_type: "ephemeral",
    text: terminalText,
  });
}

interface MentionMessageBase {
  readonly channel: string;
  readonly text: string;
  readonly metadata?: {
    readonly event_type: typeof SLACK_METADATA_EVENT_TYPE;
    readonly event_payload: { readonly thread_id: string; readonly message_id: string };
  };
  readonly blocks?: ReadonlyArray<object>;
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
  readonly failureMessage?: (
    error: unknown,
    invocation: IngressInvocation,
  ) => { readonly text: string; readonly blocks?: ReadonlyArray<object> } | null;
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
    const configuredFailure = input.failureMessage?.(error, invocation);
    await input.updateMessage({
      channel: input.channelId,
      ts: starting.ts,
      text: configuredFailure?.text ?? failureText(error, input.publicBaseUrl),
      ...(configuredFailure?.blocks ? { blocks: configuredFailure.blocks } : {}),
    });
    return;
  }
  await input.updateMessage({
    channel: input.channelId,
    ts: starting.ts,
    text:
      result.recovery === "unverified"
        ? `T3 Code could not verify whether the conversation started. Open ${input.publicBaseUrl}`
        : `Open in T3 Code: ${result.deepLink}`,
    metadata,
  });
}

export function makeSlackApp(
  input: {
    readonly config: SlackAppConfig;
    readonly transport: T3Transport;
  },
  dependencies: {
    readonly postResponseUrl?: (url: string, payload: object) => Promise<void>;
  } = {},
): {
  readonly app: App;
  readonly receiver: SocketModeReceiver;
  readonly appHome: { readonly start: () => void; readonly stop: () => Promise<void> };
} {
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
  const shellProjection = makeShellProjection({
    transport: input.transport,
    onError: (error) =>
      app.logger.warn("slack.app-home.projection-failed", {
        category: error instanceof T3TransportError ? error.kind : "unexpected",
      }),
  });
  const appHomePublisher = makeAppHomePublisher({
    publicBaseUrl: input.config.t3PublicBaseUrl,
    resolveEnvironmentId: () =>
      Effect.runPromise(input.transport.getServerConfig()).then(
        (config) => config.environment.environmentId,
      ),
    publish: (userId, view) =>
      app.client.views.publish({ user_id: userId, view: view as never }).then(() => undefined),
    onError: (error, userId) =>
      app.logger.warn("slack.app-home.publish-failed", {
        ...(userId === null ? {} : { userId }),
        category: error instanceof T3TransportError ? error.kind : "unexpected",
      }),
  });
  const unsubscribeAppHome = shellProjection.subscribe(appHomePublisher.updated);
  const slashResponseUrls = new Map<string, { readonly url: string; readonly expiresAt: number }>();
  const rememberSlashResponseUrl = (key: string, url: string) => {
    const now = Date.now();
    for (const [storedKey, entry] of slashResponseUrls) {
      if (entry.expiresAt <= now) slashResponseUrls.delete(storedKey);
    }
    if (slashResponseUrls.size >= 1_024) {
      const oldestKey = slashResponseUrls.keys().next().value;
      if (oldestKey) slashResponseUrls.delete(oldestKey);
    }
    slashResponseUrls.set(key, { url, expiresAt: Date.now() + 30 * 60_000 });
  };
  const responseUrlFor = (key: string): string | null => {
    const entry = slashResponseUrls.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      slashResponseUrls.delete(key);
      return null;
    }
    return entry.url;
  };
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

  const startCustomWithLogging = async (input_: Parameters<typeof startCustomIngress>[0]) => {
    const { threadId } = deriveIngressIds(input_.invocation);
    app.logger.info("slack.ingress.started", {
      surface: input_.invocation.surface,
      threadId,
    });
    try {
      const result = await Effect.runPromise(startCustomIngress(input_));
      app.logger.info("slack.ingress.completed", {
        surface: input_.invocation.surface,
        threadId,
        recovery: result.recovery,
      });
      return result;
    } catch (error) {
      app.logger.warn("slack.ingress.failed", {
        surface: input_.invocation.surface,
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

  const postResponseUrl =
    dependencies.postResponseUrl ??
    (async (url: string, payload: object) => {
      const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(payload));
      await Effect.runPromise(
        HttpClient.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.asVoid,
          Effect.provide(FetchHttpClient.layer),
        ),
      );
    });

  const postCustomStarting = async (
    origin: SetupOrigin,
    ids: ReturnType<typeof deriveIngressIds>,
    prompt: string,
  ) => {
    const metadata = {
      event_type: SLACK_METADATA_EVENT_TYPE,
      event_payload: { thread_id: ids.threadId, message_id: ids.messageId },
    } as const;
    if (origin.response.kind === "response-url") {
      const responseUrl = origin.response.responseKey
        ? responseUrlFor(origin.response.responseKey)
        : null;
      if (!responseUrl) throw new Error("The Slack response window expired.");
      await postResponseUrl(responseUrl, {
        response_type: "ephemeral",
        text: "Starting in T3 Code...",
        metadata,
      });
      return {
        update: (text: string) =>
          postResponseUrl(responseUrl, {
            replace_original: true,
            response_type: "ephemeral",
            text,
            metadata,
          }),
      };
    }
    /* oxlint-disable unicorn/require-post-message-target-origin -- Slack Web API method, not Window.postMessage. */
    const starting = await app.client.chat.postMessage({
      channel: origin.response.channelId,
      ...(origin.response.threadTimestamp ? { thread_ts: origin.response.threadTimestamp } : {}),
      text: "Starting in T3 Code...",
      metadata,
    });
    if (!origin.response.threadTimestamp && starting.ts) {
      await app.client.chat.postMessage({
        channel: origin.response.channelId,
        thread_ts: starting.ts,
        text: `Prompt: ${prompt}`,
      });
    }
    /* oxlint-enable unicorn/require-post-message-target-origin */
    return {
      update: (text: string) =>
        starting.ts
          ? app.client.chat
              .update({
                channel: origin.response.channelId,
                ts: starting.ts,
                text,
                metadata,
              })
              .then(() => undefined)
          : Promise.resolve(),
    };
  };

  const openSetup = async (setup: ConfigurePayload, triggerId: string, client: App["client"]) => {
    const opened = await client.views.open({
      trigger_id: triggerId,
      view: buildLoadingSetupView(setup) as never,
    });
    const viewId = opened.view?.id;
    if (!viewId) return;
    try {
      const catalog = await Effect.runPromise(
        loadSetupCatalog({
          transport: input.transport,
          projectId: input.config.projectId,
          integrationDefault: input.config.modelSelection,
          fallbackToFirstProject: true,
        }),
      );
      await client.views.update({
        view_id: viewId,
        view: buildSetupView({ origin: setup.origin, prompt: setup.prompt, catalog }) as never,
      });
    } catch (error) {
      await client.views.update({
        view_id: viewId,
        view: buildSetupErrorView({
          origin: setup.origin,
          message: failureText(error, input.config.t3PublicBaseUrl),
        }) as never,
      });
    }
  };

  app.command(SLACK_COMMAND, async ({ ack, command, respond }) => {
    await handleSlashCommand({
      teamId: command.team_id,
      responseUrl: command.response_url,
      text: command.text,
      publicBaseUrl: input.config.t3PublicBaseUrl,
      ack: async (message) => {
        if (message) await ack(message);
        else await ack();
      },
      respond: async (message) => {
        await respond(message as never);
      },
      postVisible: async (message) => {
        /* oxlint-disable unicorn/require-post-message-target-origin -- Slack Web API method, not Window.postMessage. */
        const starting = await app.client.chat.postMessage({
          channel: command.channel_id,
          ...message,
        });
        if (starting.ts) {
          await app.client.chat.postMessage({
            channel: command.channel_id,
            thread_ts: starting.ts,
            text: `Prompt: ${command.text.trim()}`,
          });
        }
        /* oxlint-enable unicorn/require-post-message-target-origin */
        return starting;
      },
      updateVisible: (message) =>
        app.client.chat.update({ channel: command.channel_id, ...message }),
      failureMessage: (error, invocation) => {
        if (!canConfigureFailure(error) || promptValidationMessage(invocation.prompt)) return null;
        rememberSlashResponseUrl(invocation.invocationId, command.response_url);
        const origin: SetupOrigin = {
          invocation: invocationWithoutPrompt(invocation),
          response: {
            kind: "response-url",
            channelId: command.channel_id,
            responseKey: invocation.invocationId,
          },
        };
        return {
          text: `${error.message} Configure this conversation instead.`,
          blocks: configureBlocks(origin, invocation.prompt),
        };
      },
      start: startWithLogging,
    });
  });

  app.command(SLACK_CUSTOM_COMMAND, async ({ ack, command, client, respond }) => {
    await ack();
    const invocation = normalizeCustomSlashInvocation({
      teamId: command.team_id,
      responseUrl: command.response_url,
      text: command.text,
    });
    const promptError = promptValidationMessage(invocation.prompt);
    if (promptError) {
      await respond({ response_type: "ephemeral", text: promptError });
      return;
    }
    await openSetup(
      {
        origin: {
          invocation: invocationWithoutPrompt(invocation),
          response: {
            kind: "message",
            channelId: command.channel_id,
          },
        },
        prompt: invocation.prompt,
      },
      command.trigger_id,
      client,
    );
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
    const normalizedMention = normalizeMentionInvocation({
      teamId: body.team_id,
      channelId: mention.channel,
      botUserId,
      eventId: body.event_id,
      messageTimestamp: mention.ts,
      text: mention.text,
    });
    if (isCustomMentionPrompt(normalizedMention.prompt)) {
      const invocation = normalizeCustomMentionInvocation({
        teamId: body.team_id,
        channelId: mention.channel,
        botUserId,
        eventId: body.event_id,
        messageTimestamp: mention.ts,
        text: mention.text,
      });
      const origin: SetupOrigin = {
        invocation: invocationWithoutPrompt(invocation),
        response: {
          kind: "message",
          channelId: mention.channel,
          threadTimestamp: mention.thread_ts ?? mention.ts,
        },
      };
      const promptError = promptValidationMessage(invocation.prompt);
      /* oxlint-disable unicorn/require-post-message-target-origin -- Slack Web API method, not Window.postMessage. */
      await client.chat.postMessage({
        channel: mention.channel,
        thread_ts: mention.thread_ts ?? mention.ts,
        text: promptError ?? "Configure this T3 Code conversation.",
        ...(promptError ? {} : { blocks: configureBlocks(origin, invocation.prompt) }),
      });
      /* oxlint-enable unicorn/require-post-message-target-origin */
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
      failureMessage: (error, invocation) => {
        if (!canConfigureFailure(error) || promptValidationMessage(invocation.prompt)) return null;
        const origin: SetupOrigin = {
          invocation: invocationWithoutPrompt(invocation),
          response: {
            kind: "message",
            channelId: mention.channel,
            threadTimestamp: mention.thread_ts ?? mention.ts,
          },
        };
        return {
          text: `${error.message} Configure this conversation instead.`,
          blocks: configureBlocks(origin, invocation.prompt),
        };
      },
      start: startWithLogging,
    });
  });

  app.event("app_home_opened", async ({ event }) => {
    if (event.tab !== "home") return;
    const snapshot = await resolveAppHomeOpenSnapshot({
      getSnapshot: shellProjection.getSnapshot,
      refresh: () => Effect.runPromise(shellProjection.refresh()),
      onRefreshError: (error) => {
        app.logger.warn("slack.app-home.snapshot-failed", {
          category: error instanceof T3TransportError ? error.kind : "unexpected",
        });
      },
    });
    await appHomePublisher.opened(event.user, snapshot);
  });

  app.message(async ({ message, body, client }) => {
    if (
      !("channel_type" in message) ||
      message.channel_type !== "im" ||
      !("text" in message) ||
      typeof message.text !== "string" ||
      "bot_id" in message
    ) {
      return;
    }
    const teamId = body.team_id ?? body.team?.id;
    if (!teamId) {
      app.logger.warn("slack.ingress.rejected", {
        surface: "dm",
        category: "team_identity_missing",
      });
      return;
    }
    const rootTimestamp = "thread_ts" in message ? (message.thread_ts ?? message.ts) : message.ts;
    const invocation = normalizeDirectMessageInvocation({
      teamId,
      channelId: message.channel,
      rootTimestamp,
      text: message.text,
    });
    const origin: SetupOrigin = {
      invocation: invocationWithoutPrompt(invocation),
      response: { kind: "message", channelId: message.channel, threadTimestamp: rootTimestamp },
    };
    const promptError = promptValidationMessage(invocation.prompt);
    /* oxlint-disable unicorn/require-post-message-target-origin -- Slack Web API method, not Window.postMessage. */
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: rootTimestamp,
      text: promptError ?? "Configure this T3 Code conversation.",
      ...(promptError ? {} : { blocks: configureBlocks(origin, invocation.prompt) }),
    });
    /* oxlint-enable unicorn/require-post-message-target-origin */
  });

  app.action(SETUP_CONFIGURE_ACTION, async ({ ack, action, body, client }) => {
    await ack();
    if (!("value" in action) || typeof action.value !== "string" || !("trigger_id" in body)) return;
    let origin: SetupOrigin;
    try {
      origin = parseJson<SetupOrigin>(action.value);
    } catch {
      app.logger.warn("slack.ingress.rejected", {
        surface: "configure",
        category: "invalid_origin",
      });
      return;
    }
    const prompt = promptFromActionBody(body);
    if (!prompt) {
      const text = "The original prompt is no longer available. Start the setup flow again.";
      if (origin.response.kind === "response-url" && origin.response.responseKey) {
        const responseUrl = responseUrlFor(origin.response.responseKey);
        if (responseUrl) {
          await postResponseUrl(responseUrl, { response_type: "ephemeral", text }).catch(
            () => undefined,
          );
        }
      } else {
        /* oxlint-disable unicorn/require-post-message-target-origin -- Slack Web API method, not Window.postMessage. */
        await client.chat
          .postMessage({
            channel: origin.response.channelId,
            ...(origin.response.threadTimestamp
              ? { thread_ts: origin.response.threadTimestamp }
              : {}),
            text,
          })
          .catch(() => undefined);
        /* oxlint-enable unicorn/require-post-message-target-origin */
      }
      return;
    }
    await openSetup({ origin, prompt }, body.trigger_id, client);
  });

  const updateSetupView = async (
    rawBody: unknown,
    client: App["client"],
    changed: "project" | "workspace",
  ) => {
    if (!rawBody || typeof rawBody !== "object" || !("view" in rawBody)) return;
    const rawView = rawBody.view;
    if (!rawView || typeof rawView !== "object" || !("id" in rawView) || !("state" in rawView))
      return;
    const view = rawView as {
      readonly id: string;
      readonly hash?: string;
      readonly private_metadata: string;
      readonly state: { readonly values: SetupStateValues };
    };
    const origin = parseJson<SetupOrigin>(view.private_metadata);
    const projectId = stateValue(view.state.values, SETUP_PROJECT_ACTION) ?? input.config.projectId;
    const workspace =
      stateValue(view.state.values, SETUP_WORKSPACE_ACTION) === "new-worktree"
        ? "new-worktree"
        : "current";
    try {
      const catalog = await Effect.runPromise(
        loadSetupCatalog({
          transport: input.transport,
          projectId,
          integrationDefault: input.config.modelSelection,
        }),
      );
      await client.views.update({
        view_id: view.id,
        ...(view.hash ? { hash: view.hash } : {}),
        view: buildSetupView({
          origin,
          prompt: stateValue(view.state.values, SETUP_PROMPT_ACTION) ?? "",
          catalog,
          workspace,
          ...(changed === "workspace" && stateValue(view.state.values, SETUP_MODEL_ACTION)
            ? { modelOption: stateValue(view.state.values, SETUP_MODEL_ACTION)! }
            : {}),
        }) as never,
      });
    } catch (error) {
      await client.views.update({
        view_id: view.id,
        ...(view.hash ? { hash: view.hash } : {}),
        view: buildSetupErrorView({
          origin,
          message: failureText(error, input.config.t3PublicBaseUrl),
        }) as never,
      });
    }
  };

  app.action(SETUP_PROJECT_ACTION, async ({ ack, body, client }) => {
    await ack();
    await updateSetupView(body, client, "project");
  });
  app.action(SETUP_WORKSPACE_ACTION, async ({ ack, body, client }) => {
    await ack();
    await updateSetupView(body, client, "workspace");
  });

  app.options(SETUP_PROJECT_ACTION, async ({ options, ack }) => {
    const projects = await withSlackOptionsDeadline(
      Effect.runPromise(
        loadProjectOptions({ transport: input.transport, query: options.value }),
      ).then(projectSlackOptions),
      [],
    );
    await ack({ options: projects });
  });

  app.options(SETUP_BRANCH_ACTION, async ({ options, ack }) => {
    const view = options.view;
    if (!view) return ack({ options: [] });
    const values = view.state.values as SetupStateValues;
    const projectId = stateValue(values, SETUP_PROJECT_ACTION) ?? input.config.projectId;
    const branchOptions = await withSlackOptionsDeadline(
      Effect.runPromise(
        loadBranchCatalog({
          transport: input.transport,
          projectId,
          query: options.value,
        }),
      ).then(branchSlackOptions),
      [],
    );
    await ack({ options: branchOptions });
  });

  app.options(SETUP_MODEL_ACTION, async ({ options, ack }) => {
    const view = options.view;
    if (!view) return ack({ options: [] });
    const values = view.state.values as SetupStateValues;
    const projectId = stateValue(values, SETUP_PROJECT_ACTION) ?? input.config.projectId;
    const optionGroups = await withSlackOptionsDeadline(
      Effect.runPromise(
        loadModelOptions({
          transport: input.transport,
          projectId,
          integrationDefault: input.config.modelSelection,
        }),
      ).then((models) => modelSlackOptionGroups(models, options.value)),
      [],
    );
    await ack({ option_groups: optionGroups } as never);
  });

  app.view(SETUP_CALLBACK_ID, async ({ ack, view }) => {
    const values = view.state.values as SetupStateValues;
    const prompt = stateValue(values, SETUP_PROMPT_ACTION)?.trim() ?? "";
    const projectId = stateValue(values, SETUP_PROJECT_ACTION);
    const workspace = stateValue(values, SETUP_WORKSPACE_ACTION);
    const branchValue = stateValue(values, SETUP_BRANCH_ACTION);
    const modelOption = stateValue(values, SETUP_MODEL_ACTION);
    if (
      promptValidationMessage(prompt) ||
      !projectId ||
      (workspace !== "current" && workspace !== "new-worktree") ||
      !modelOption
    ) {
      await ack({
        response_action: "errors",
        errors: { t3_setup_prompt_block: "Complete all setup fields before starting." },
      });
      return;
    }
    const origin = parseJson<SetupOrigin>(view.private_metadata);
    if (
      origin.response.kind === "response-url" &&
      (!origin.response.responseKey || !responseUrlFor(origin.response.responseKey))
    ) {
      await ack({
        response_action: "errors",
        errors: {
          t3_setup_prompt_block: "This Slack response window expired. Run /t3-custom again.",
        },
      });
      return;
    }
    await ack();
    const invocation: IngressInvocation = { ...origin.invocation, prompt };
    const ids = deriveIngressIds(invocation);
    let starting: Awaited<ReturnType<typeof postCustomStarting>> | null = null;
    let terminalText: string | null = null;
    try {
      starting = await postCustomStarting(origin, ids, prompt);
      const result = await startCustomWithLogging({
        invocation,
        selection: {
          projectId,
          workspace: workspace === "new-worktree" ? "new-worktree" : "current",
          branch: branchValue === "no-repository" ? null : branchValue,
          modelOption,
        },
        integrationDefault: input.config.modelSelection,
        requestedAt: new Date().toISOString(),
        publicBaseUrl: input.config.t3PublicBaseUrl,
        transport: input.transport,
      });
      terminalText =
        result.recovery === "unverified"
          ? `T3 Code could not verify whether the conversation started. Open ${input.config.t3PublicBaseUrl}`
          : `Open in T3 Code: ${result.deepLink}`;
      await starting.update(terminalText);
    } catch (error) {
      const text = terminalText ?? failureText(error, input.config.t3PublicBaseUrl);
      app.logger.warn("slack.ingress.custom-submit-failed", {
        surface: invocation.surface,
        threadId: ids.threadId,
        category:
          error instanceof IngressFailure
            ? error.code
            : error instanceof T3TransportError
              ? error.kind
              : "unexpected",
      });
      if (starting) {
        await starting.update(text).catch(() => undefined);
      } else if (origin.response.kind === "response-url" && origin.response.responseKey) {
        const responseUrl = responseUrlFor(origin.response.responseKey);
        if (responseUrl) {
          await postResponseUrl(responseUrl, {
            response_type: "ephemeral",
            text,
          }).catch(() => undefined);
        }
      } else {
        /* oxlint-disable unicorn/require-post-message-target-origin -- Slack Web API method, not Window.postMessage. */
        await app.client.chat
          .postMessage({ channel: origin.response.channelId, text })
          .catch(() => undefined);
        /* oxlint-enable unicorn/require-post-message-target-origin */
      }
    } finally {
      if (origin.response.kind === "response-url" && origin.response.responseKey) {
        slashResponseUrls.delete(origin.response.responseKey);
      }
    }
  });

  return {
    app,
    receiver,
    appHome: {
      start: shellProjection.start,
      stop: async () => {
        unsubscribeAppHome();
        const pendingPublications = appHomePublisher.stop();
        await shellProjection.stop();
        await pendingPublications;
      },
    },
  };
}
