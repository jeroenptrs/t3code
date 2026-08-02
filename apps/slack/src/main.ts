import * as NodeFSP from "node:fs/promises";

import {
  CredentialReadError,
  INGRESS_IDENTITY_VERSION,
  makeLiveT3Transport,
  REQUIRED_T3_SCOPES,
  resolveStandardIngressTarget,
} from "@t3tools/integration-runtime";
import * as Effect from "effect/Effect";

import { makeSlackApp } from "./app.ts";
import { decodeSlackAppConfig } from "./config.ts";
import { startHealthServer, type HealthState } from "./health.ts";
import { makeSlackDaemonLifecycle, type SlackDaemonLifecycle } from "./lifecycle.ts";

const config = decodeSlackAppConfig(process.env);
let health: HealthState = { live: true, ready: false, reason: "starting" };
const healthServer = startHealthServer({
  host: config.healthHost,
  port: config.healthPort,
  state: () => health,
});

const readBearerCredential = Effect.tryPromise({
  try: () => NodeFSP.readFile(config.t3BearerCredentialFile, "utf8"),
  catch: (cause) => new CredentialReadError("Unable to read the T3 credential file.", cause),
});
const transport = await Effect.runPromise(
  makeLiveT3Transport({ httpBaseUrl: config.t3HttpBaseUrl, readBearerCredential }),
);
const { app, receiver, appHome } = makeSlackApp({ config, transport });
let slackConnected = false;
let lifecycle: SlackDaemonLifecycle | null = null;
receiver.client.on("connected", () => {
  if (lifecycle?.isShuttingDown()) return;
  slackConnected = true;
  lifecycle?.requestReadiness();
});
receiver.client.on("reconnecting", () => {
  if (lifecycle?.isShuttingDown()) return;
  slackConnected = false;
  health = { live: true, ready: false, reason: "Slack Socket Mode is reconnecting" };
});
receiver.client.on("disconnected", () => {
  if (lifecycle?.isShuttingDown()) return;
  slackConnected = false;
  health = { live: true, ready: false, reason: "Slack Socket Mode is disconnected" };
});

async function refreshReadiness(): Promise<void> {
  if (lifecycle?.isShuttingDown()) return;
  if (!slackConnected) {
    health = { live: true, ready: false, reason: "Slack Socket Mode is disconnected" };
    return;
  }
  try {
    const [session, serverConfig, shell] = await Promise.all([
      Effect.runPromise(transport.validateSession()),
      Effect.runPromise(transport.getServerConfig()),
      Effect.runPromise(transport.getShellSnapshot()),
    ]);
    const scopes = new Set(session.scopes ?? []);
    if (!session.authenticated || REQUIRED_T3_SCOPES.some((scope) => !scopes.has(scope))) {
      throw new Error("The T3 credential is missing orchestration read/operate scopes.");
    }
    await Effect.runPromise(
      resolveStandardIngressTarget({
        request: {
          invocation: {
            identityVersion: INGRESS_IDENTITY_VERSION,
            integration: "slack",
            tenantId: "readiness",
            surface: "readiness",
            invocationId: "readiness",
            prompt: "readiness",
          },
          target: { projectId: config.projectId, modelSelection: config.modelSelection },
          requestedAt: new Date().toISOString(),
        },
        shell,
        config: serverConfig,
      }),
    );
    if (lifecycle?.isShuttingDown()) return;
    health = { live: true, ready: true, reason: null };
  } catch (error) {
    if (lifecycle?.isShuttingDown()) return;
    health = { live: true, ready: false, reason: "T3 readiness check failed" };
    app.logger.warn("slack.readiness.failed", {
      category:
        typeof error === "object" && error !== null && "kind" in error
          ? String(error.kind)
          : "validation_or_unavailable",
    });
  }
}

lifecycle = makeSlackDaemonLifecycle({
  startSlack: async () => {
    await app.start();
    slackConnected = true;
  },
  stopSlack: async () => {
    slackConnected = false;
    await app.stop();
  },
  startAppHome: appHome.start,
  stopAppHome: appHome.stop,
  refreshReadiness,
  closeTransport: () => Effect.runPromise(transport.close()),
  closeHealth: () => new Promise<void>((resolve) => healthServer.close(() => resolve())),
  onStartFailure: () => {
    slackConnected = false;
    health = { live: true, ready: false, reason: "Slack Socket Mode is disconnected" };
  },
});

const shutdown = (): Promise<void> => {
  health = { live: false, ready: false, reason: "shutting down" };
  return lifecycle?.shutdown() ?? Promise.resolve();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await lifecycle.start();
