import * as NodeFSP from "node:fs/promises";

import {
  CredentialReadError,
  INGRESS_IDENTITY_VERSION,
  makeLiveT3Transport,
  REQUIRED_T3_SCOPES,
  resolveStandardIngressTarget,
} from "@t3tools/integration-runtime";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import { makeSlackApp } from "./app.ts";
import { decodeSlackAppConfig } from "./config.ts";
import { startHealthServer, type HealthState } from "./health.ts";
import { makeSlackDaemonLifecycle, type SlackDaemonLifecycle } from "./lifecycle.ts";
import { makeOperationalHealth, type OperationalHealth } from "./operationalHealth.ts";
import { makeReadinessCoordinator } from "./readiness.ts";
import { hasExactScopes } from "./scopes.ts";

const config = decodeSlackAppConfig(process.env);
let health: HealthState = { live: true, ready: false, reason: "starting" };
let operationalHealth: OperationalHealth | null = null;
const healthServer = startHealthServer({
  host: config.healthHost,
  port: config.healthPort,
  state: () => operationalHealth?.state() ?? health,
});

const readBearerCredential = Effect.tryPromise({
  try: () => NodeFSP.readFile(config.t3BearerCredentialFile, "utf8"),
  catch: (cause) => new CredentialReadError("Unable to read the T3 credential file.", cause),
});
const transport = await Effect.runPromise(
  makeLiveT3Transport({ httpBaseUrl: config.t3HttpBaseUrl, readBearerCredential }),
);
const { app, receiver, appHome } = makeSlackApp({ config, transport });
operationalHealth = makeOperationalHealth({
  initial: { live: false, ready: false, reason: "initializing" },
  logger: app.logger,
  credentialExpiryWarningDays: config.credentialExpiryWarningDays,
});
operationalHealth.update(health);
const updateHealth = (next: HealthState, details?: { readonly category?: string }): void => {
  health = next;
  operationalHealth?.update(next, details);
};
let lifecycle: SlackDaemonLifecycle | null = null;
const readiness = makeReadinessCoordinator({
  isShuttingDown: () => lifecycle?.isShuttingDown() ?? false,
  check: async () => {
    const session = await Effect.runPromise(transport.validateSession());
    if (session.expiresAt) {
      operationalHealth?.observeCredentialExpiry(DateTime.formatIso(session.expiresAt));
    }
    if (!session.authenticated || !hasExactScopes(session.scopes, REQUIRED_T3_SCOPES)) {
      throw new Error("The T3 credential does not have the exact required scopes.");
    }
    const [serverConfig, shell] = await Promise.all([
      Effect.runPromise(transport.getServerConfig()),
      Effect.runPromise(transport.getShellSnapshot()),
    ]);
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
  },
  onReady: () => updateHealth({ live: true, ready: true, reason: null }),
  onFailure: (error) =>
    updateHealth(
      { live: true, ready: false, reason: "T3 readiness check failed" },
      {
        category:
          typeof error === "object" && error !== null && "kind" in error
            ? String(error.kind)
            : "validation_or_unavailable",
      },
    ),
  onUnavailable: (reason) => updateHealth({ live: true, ready: false, reason }),
});

receiver.client.on("connected", () => {
  if (lifecycle?.isShuttingDown()) return;
  readiness.setConnected(true);
  lifecycle?.requestReadiness();
});
receiver.client.on("reconnecting", () => {
  readiness.setConnected(false, "Slack Socket Mode is reconnecting");
});
receiver.client.on("disconnected", () => {
  readiness.setConnected(false, "Slack Socket Mode is disconnected");
});

lifecycle = makeSlackDaemonLifecycle({
  startSlack: async () => {
    await app.start();
    readiness.setConnected(true);
  },
  stopSlack: async () => {
    readiness.setConnected(false);
    await app.stop();
  },
  startAppHome: appHome.start,
  stopAppHome: appHome.stop,
  refreshReadiness: readiness.run,
  closeTransport: () => Effect.runPromise(transport.close()),
  closeHealth: () => new Promise<void>((resolve) => healthServer.close(() => resolve())),
  onStartFailure: () => {
    readiness.setConnected(false);
  },
});

const shutdown = (): Promise<void> => {
  updateHealth({ live: false, ready: false, reason: "shutting down" });
  return lifecycle?.shutdown() ?? Promise.resolve();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await lifecycle.start();
