import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ClientOrchestrationCommand,
  type OrchestrationShellSnapshot,
  type ServerConfig,
} from "@t3tools/contracts";
import type { T3Transport } from "@t3tools/integration-runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const bolt = vi.hoisted(() => {
  const commands = new Map<string, unknown>();
  const events = new Map<string, unknown>();
  const actions = new Map<string, unknown>();
  const options = new Map<string, unknown>();
  const views = new Map<string, unknown>();
  const messages: Array<unknown> = [];
  const client = {
    views: {
      open: vi.fn(async (_input: unknown) => ({ view: { id: "V1" } })),
      update: vi.fn(async (_input: unknown) => ({})),
      publish: vi.fn(async (_input: unknown) => ({})),
    },
    chat: {
      postMessage: vi.fn(async (_input: unknown) => ({ ts: "100.1" })),
      update: vi.fn(async (_input: unknown) => ({})),
    },
  };
  return { commands, events, actions, options, views, messages, client };
});

vi.mock("@slack/bolt", () => ({
  App: class {
    readonly client = bolt.client;
    readonly logger = { info: vi.fn(), warn: vi.fn() };
    command(name: string, handler: unknown) {
      bolt.commands.set(name, handler);
    }
    event(name: string, handler: unknown) {
      bolt.events.set(name, handler);
    }
    action(name: string, handler: unknown) {
      bolt.actions.set(name, handler);
    }
    options(name: string, handler: unknown) {
      bolt.options.set(name, handler);
    }
    view(name: string, handler: unknown) {
      bolt.views.set(name, handler);
    }
    message(handler: unknown) {
      bolt.messages.push(handler);
    }
  },
  LogLevel: { INFO: "info" },
  SocketModeReceiver: class {
    readonly kind = "socket-mode";
  },
}));

import { makeSlackApp, SLACK_COMMAND, SLACK_CUSTOM_COMMAND } from "./app.ts";
import {
  SETUP_BRANCH_ACTION,
  SETUP_CALLBACK_ID,
  SETUP_CONFIGURE_ACTION,
  SETUP_MODEL_ACTION,
  SETUP_PROJECT_ACTION,
  SETUP_PROMPT_ACTION,
  SETUP_WORKSPACE_ACTION,
} from "./setup.ts";

type AsyncHandler = (input: never) => Promise<void>;

const handler = (registry: Map<string, unknown>, name: string): AsyncHandler => {
  const registered = registry.get(name);
  if (typeof registered !== "function") throw new Error(`Missing Slack handler: ${name}`);
  return registered as AsyncHandler;
};

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};

const makeTransport = (commands: Array<ClientOrchestrationCommand>): T3Transport => ({
  close: () => Effect.void,
  validateSession: () => Effect.die("not used"),
  getThreadSnapshot: () => Effect.succeed(null),
  getShellSnapshot: () =>
    Effect.succeed({
      snapshotSequence: 1,
      projects: [
        {
          id: ProjectId.make("project-a"),
          title: "Project A",
          workspaceRoot: "/repo",
          defaultModelSelection: modelSelection,
          scripts: [],
        },
      ],
      threads: [],
      updatedAt: "2026-08-02T00:00:00.000Z",
    } as unknown as OrchestrationShellSnapshot),
  subscribeShell: () => Stream.never,
  getServerConfig: () =>
    Effect.succeed({
      environment: { environmentId: EnvironmentId.make("environment-a") },
      settings: { newWorktreesStartFromOrigin: false },
      providers: [
        {
          instanceId: modelSelection.instanceId,
          displayName: "Codex",
          enabled: true,
          installed: true,
          availability: "available",
          status: "ready",
          auth: { status: "authenticated" },
          models: [{ slug: modelSelection.model, name: "GPT-5" }],
        },
      ],
    } as unknown as ServerConfig),
  dispatch: (command) => {
    commands.push(command);
    return Effect.succeed({ sequence: commands.length });
  },
  dispatchBootstrap: (command) => {
    commands.push(command);
    return Effect.succeed({ sequence: commands.length });
  },
  listRefs: () =>
    Effect.succeed({
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 1,
      refs: [
        {
          name: "main",
          current: true,
          isDefault: true,
          isRemote: false,
          worktreePath: "/repo",
        },
      ],
    }),
  switchRef: () => Effect.die("root starts use server bootstrap"),
});

const config = {
  slackAppToken: "xapp-test",
  slackBotToken: "xoxb-test",
  t3HttpBaseUrl: "https://t3.example",
  t3PublicBaseUrl: "https://t3.example",
  t3BearerCredentialFile: "/tmp/test-credential",
  projectId: ProjectId.make("project-a"),
  modelSelection,
  healthHost: "127.0.0.1",
  healthPort: 3210,
};

beforeEach(() => {
  bolt.commands.clear();
  bolt.events.clear();
  bolt.actions.clear();
  bolt.options.clear();
  bolt.views.clear();
  bolt.messages.length = 0;
  vi.clearAllMocks();
});

describe("makeSlackApp Slack handlers", () => {
  it("publishes a fresh App Home view for app_home_opened", async () => {
    makeSlackApp({ config, transport: makeTransport([]) });

    await handler(bolt.events, "app_home_opened")({ event: { user: "U1", tab: "home" } } as never);

    expect(bolt.client.views.publish).toHaveBeenCalledWith({
      user_id: "U1",
      view: expect.objectContaining({ type: "home", blocks: expect.any(Array) }),
    });
  });

  it("ignores app_home_opened events for the Messages tab", async () => {
    makeSlackApp({ config, transport: makeTransport([]) });

    await handler(
      bolt.events,
      "app_home_opened",
    )({
      event: { user: "U1", tab: "messages" },
    } as never);

    expect(bolt.client.views.publish).not.toHaveBeenCalled();
  });

  it("acknowledges /t3 before posting a public link with a threaded prompt trace", async () => {
    makeSlackApp({ config, transport: makeTransport([]) });
    const ack = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);

    await handler(
      bolt.commands,
      SLACK_COMMAND,
    )({
      ack,
      respond,
      command: {
        team_id: "T1",
        channel_id: "C1",
        response_url: "https://hooks.slack.test/standard-response",
        text: "Inspect CI",
      },
    } as never);

    expect(ack).toHaveBeenCalledWith();
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(
      bolt.client.chat.postMessage.mock.invocationCallOrder[0]!,
    );
    expect(respond).not.toHaveBeenCalled();
    expect(bolt.client.chat.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ channel: "C1", text: "Starting in T3 Code..." }),
    );
    expect(bolt.client.chat.postMessage).toHaveBeenNthCalledWith(2, {
      channel: "C1",
      thread_ts: "100.1",
      text: "Prompt: Inspect CI",
    });
    expect(bolt.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "100.1",
        text: expect.stringMatching(/^Open in T3 Code: https:\/\//),
      }),
    );
  });

  it("falls back to a surviving project when the configured project was deleted", async () => {
    makeSlackApp({
      config: { ...config, projectId: ProjectId.make("deleted-project") },
      transport: makeTransport([]),
    });

    await handler(
      bolt.commands,
      SLACK_CUSTOM_COMMAND,
    )({
      ack: vi.fn(async () => undefined),
      command: {
        team_id: "T1",
        channel_id: "C1",
        trigger_id: "trigger-stale-project",
        response_url: "https://hooks.slack.test/response",
        text: "Inspect CI",
      },
      client: bolt.client,
    } as never);

    expect(bolt.client.views.update).toHaveBeenCalledWith(
      expect.objectContaining({
        view: expect.objectContaining({
          callback_id: SETUP_CALLBACK_ID,
          blocks: expect.arrayContaining([
            expect.objectContaining({
              element: expect.objectContaining({
                action_id: SETUP_PROJECT_ACTION,
                initial_option: expect.objectContaining({ value: "project-a" }),
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("acknowledges an empty /t3-custom before returning usage guidance", async () => {
    makeSlackApp({ config, transport: makeTransport([]) });
    const ack = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);

    await handler(
      bolt.commands,
      SLACK_CUSTOM_COMMAND,
    )({
      ack,
      respond,
      command: {
        team_id: "T1",
        channel_id: "C1",
        trigger_id: "trigger-empty",
        response_url: "https://hooks.slack.test/empty-custom",
        text: "",
      },
      client: bolt.client,
    } as never);

    expect(ack).toHaveBeenCalledWith();
    expect(respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: expect.stringContaining("Include a prompt"),
    });
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(respond.mock.invocationCallOrder[0]!);
    expect(bolt.client.views.open).not.toHaveBeenCalled();
  });

  it("runs the custom command, options, modal update, and public channel submission", async () => {
    const commands: Array<ClientOrchestrationCommand> = [];
    const responsePosts: Array<{ readonly url: string; readonly payload: object }> = [];
    makeSlackApp(
      { config, transport: makeTransport(commands) },
      {
        postResponseUrl: async (url, payload) => {
          responsePosts.push({ url, payload });
        },
      },
    );
    const ackCommand = vi.fn(async () => undefined);

    await handler(
      bolt.commands,
      SLACK_CUSTOM_COMMAND,
    )({
      ack: ackCommand,
      command: {
        team_id: "T1",
        channel_id: "C1",
        trigger_id: "trigger-1",
        response_url: "https://hooks.slack.test/response",
        text: "Inspect CI",
      },
      client: bolt.client,
    } as never);

    expect(ackCommand).toHaveBeenCalledOnce();
    expect(ackCommand.mock.invocationCallOrder[0]).toBeLessThan(
      bolt.client.views.open.mock.invocationCallOrder[0]!,
    );
    expect(bolt.client.views.open.mock.calls[0]?.[0]).toMatchObject({
      view: { callback_id: `${SETUP_CALLBACK_ID}:loading` },
    });
    const configuredUpdate = bolt.client.views.update.mock.calls.at(-1)?.[0] as {
      readonly view: {
        readonly private_metadata: string;
        readonly blocks: ReadonlyArray<{
          readonly element: {
            readonly action_id: string;
            readonly initial_option?: { readonly value: string };
          };
        }>;
      };
    };
    const configuredView = configuredUpdate.view;
    const initialValue = (actionId: string) =>
      configuredView.blocks.find((block) => block.element.action_id === actionId)?.element
        .initial_option?.value;

    await handler(
      bolt.actions,
      SETUP_CONFIGURE_ACTION,
    )({
      ack: vi.fn(async () => undefined),
      action: { value: configuredView.private_metadata },
      body: { trigger_id: "trigger-missing-prompt" },
      client: bolt.client,
    } as never);
    expect(bolt.client.chat.postMessage).toHaveBeenLastCalledWith({
      channel: "C1",
      text: expect.stringContaining("prompt is no longer available"),
    });
    vi.clearAllMocks();

    const stateValues = {
      prompt: { [SETUP_PROMPT_ACTION]: { value: "Inspect CI" } },
      project: { [SETUP_PROJECT_ACTION]: { selected_option: { value: "project-a" } } },
      workspace: { [SETUP_WORKSPACE_ACTION]: { selected_option: { value: "current" } } },
      branch: {
        [SETUP_BRANCH_ACTION]: { selected_option: { value: initialValue(SETUP_BRANCH_ACTION)! } },
      },
      model: {
        [SETUP_MODEL_ACTION]: { selected_option: { value: initialValue(SETUP_MODEL_ACTION)! } },
      },
    };

    for (const [name, expectedKey] of [
      [SETUP_PROJECT_ACTION, "options"],
      [SETUP_BRANCH_ACTION, "options"],
      [SETUP_MODEL_ACTION, "option_groups"],
    ] as const) {
      const ack = vi.fn(async () => undefined);
      await handler(
        bolt.options,
        name,
      )({
        options: { value: "", view: { state: { values: stateValues } } },
        ack,
      } as never);
      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ [expectedKey]: expect.any(Array) }),
      );
    }

    const ackAction = vi.fn(async () => undefined);
    await handler(
      bolt.actions,
      SETUP_WORKSPACE_ACTION,
    )({
      ack: ackAction,
      body: {
        view: {
          id: "V1",
          hash: "hash-1",
          private_metadata: configuredView.private_metadata,
          state: { values: stateValues },
        },
      },
      client: bolt.client,
    } as never);
    expect(ackAction).toHaveBeenCalledOnce();
    expect(bolt.client.views.update).toHaveBeenCalledWith(
      expect.objectContaining({ view_id: "V1", hash: "hash-1" }),
    );

    const ackView = vi.fn(async () => undefined);
    await handler(
      bolt.views,
      SETUP_CALLBACK_ID,
    )({
      ack: ackView,
      view: {
        private_metadata: configuredView.private_metadata,
        state: { values: stateValues },
      },
    } as never);
    expect(ackView).toHaveBeenCalledWith();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.turn.start",
      bootstrap: { switchRef: { cwd: "/repo", refName: "main" } },
    });
    expect(responsePosts).toEqual([]);
    expect(bolt.client.chat.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "C1",
        text: "Starting in T3 Code...",
      }),
    );
    expect(bolt.client.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "C1",
        thread_ts: "100.1",
        text: "Prompt: Inspect CI",
      }),
    );
    expect(bolt.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "100.1",
        text: expect.stringMatching(/^Open in T3 Code: https:\/\//),
      }),
    );
  });

  it("routes a real DM handler into the setup action", async () => {
    const commands: Array<ClientOrchestrationCommand> = [];
    makeSlackApp({ config, transport: makeTransport(commands) });
    const dmHandler = bolt.messages[0];
    if (typeof dmHandler !== "function") throw new Error("Missing DM handler");

    await (dmHandler as AsyncHandler)({
      message: {
        channel_type: "im",
        channel: "D1",
        ts: "100.1",
        text: "Inspect CI",
      },
      body: { team_id: "T1" },
      client: bolt.client,
    } as never);

    expect(bolt.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D1",
        thread_ts: "100.1",
        text: "Configure this T3 Code conversation.",
        blocks: expect.any(Array),
      }),
    );
    expect(commands).toEqual([]);
  });
});
