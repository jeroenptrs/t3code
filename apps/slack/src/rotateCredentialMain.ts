// @effect-diagnostics globalFetch:off globalConsole:off globalDate:off globalTimers:off -- Host-side systemd rotation entrypoint uses platform HTTP, logging, and bounded readiness polling.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import {
  decodeRotationSession,
  replaceCredentialFile,
  rotateSlackCredentials,
  type CredentialRotationOperations,
  type RotationSession,
} from "./credentialRotation.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const required = (name: string): string => {
  const value = NodeProcess.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(NodeProcess.env[name]?.trim() || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
};

const httpUrl = (name: string, value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https.`);
  }
  return parsed.toString();
};

class RotationHttpError extends Error {
  readonly status: number;

  constructor(status: number, operation: string) {
    super(`T3 ${operation} request failed with status ${status}.`);
    this.status = status;
  }
}

async function main(): Promise<void> {
  const httpBaseUrl = httpUrl("T3_HTTP_URL", required("T3_HTTP_URL"));
  const readyUrl = httpUrl(
    "SLACK_READY_URL",
    NodeProcess.env.SLACK_READY_URL?.trim() || "http://127.0.0.1:3210/ready",
  );
  const serviceName = NodeProcess.env.SLACK_SYSTEMD_SERVICE?.trim() || "t3-slack.service";
  if (!/^[A-Za-z0-9_.@:-]+\.service$/.test(serviceName)) {
    throw new Error("SLACK_SYSTEMD_SERVICE must be a systemd .service unit name.");
  }
  const requestTimeoutMs = positiveInteger("SLACK_ROTATION_REQUEST_TIMEOUT_MS", 10_000);
  const readyTimeoutMs = positiveInteger("SLACK_ROTATION_READY_TIMEOUT_MS", 60_000);

  const requestJson = async (input: {
    readonly path: string;
    readonly operation: string;
    readonly credential?: string;
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly form?: URLSearchParams;
  }): Promise<unknown> => {
    const response = await fetch(new URL(input.path, httpBaseUrl), {
      method: input.method ?? "GET",
      headers: {
        ...(input.credential ? { authorization: `Bearer ${input.credential}` } : {}),
        ...(input.body ? { "content-type": "application/json" } : {}),
        ...(input.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      ...(input.form ? { body: input.form.toString() } : {}),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) throw new RotationHttpError(response.status, input.operation);
    return response.json();
  };

  const string = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`T3 returned an invalid ${field}.`);
    }
    return value;
  };

  const object = (value: unknown, subject: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`T3 returned an invalid ${subject}.`);
    }
    return value as Record<string, unknown>;
  };

  const inspectSession = async (credential: string): Promise<RotationSession | null> => {
    try {
      const response = object(
        await requestJson({
          path: "/api/auth/session",
          operation: "session validation",
          credential,
        }),
        "session response",
      );
      if (response.authenticated !== true || !Array.isArray(response.scopes)) return null;
      return decodeRotationSession(response);
    } catch (cause) {
      if (cause instanceof RotationHttpError && cause.status === 401) return null;
      throw cause;
    }
  };

  const issueSession: CredentialRotationOperations["issueSession"] = async (
    rotatorCredential,
    label,
    scopes,
  ) => {
    const pairing = object(
      await requestJson({
        path: "/api/auth/pairing-token",
        operation: "pairing credential issuance",
        credential: rotatorCredential,
        method: "POST",
        body: { label, scopes },
      }),
      "pairing credential response",
    );
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: string(pairing.credential, "pairing credential"),
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: scopes.join(" "),
      client_label: label,
      client_device_type: "bot",
    });
    const token = object(
      await requestJson({
        path: "/oauth/token",
        operation: "token exchange",
        method: "POST",
        form,
      }),
      "token response",
    );
    const credential = string(token.access_token, "access token");
    const session = await inspectSession(credential);
    if (session === null) throw new Error("T3 did not authenticate the newly issued session.");
    return { credential, session };
  };

  const operations: CredentialRotationOperations = {
    readCredential: async (file) => {
      const credential = (await NodeFSP.readFile(file, "utf8")).trim();
      if (!credential) throw new Error(`Credential file ${file} is empty.`);
      return credential;
    },
    replaceCredential: replaceCredentialFile,
    inspectSession,
    listSessions: async (credential) => {
      const response = await requestJson({
        path: "/api/auth/clients",
        operation: "session listing",
        credential,
      });
      if (!Array.isArray(response)) throw new Error("T3 returned an invalid session list.");
      return response.map(decodeRotationSession);
    },
    issueSession,
    revokeSession: async (credential, sessionId) => {
      const result = object(
        await requestJson({
          path: "/api/auth/clients/revoke",
          operation: "session revocation",
          credential,
          method: "POST",
          body: { sessionId },
        }),
        "session revocation response",
      );
      if (typeof result.revoked !== "boolean") {
        throw new Error("T3 returned an invalid session revocation response.");
      }
    },
    restartDaemon: async () => {
      await execFile("systemctl", ["restart", serviceName]);
    },
    waitUntilReady: async () => {
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(readyUrl, { signal: AbortSignal.timeout(requestTimeoutMs) });
          if (response.ok) return;
        } catch {
          // The service socket is expected to disappear briefly during restart.
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error("Slack readiness did not recover before the configured timeout.");
    },
    log: (level, event, fields = {}) => {
      const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
      if (level === "warn") console.error(line);
      else console.log(line);
    },
  };

  await rotateSlackCredentials(
    {
      daemonCredentialFile: required("T3_BEARER_CREDENTIAL_FILE"),
      rotatorCredentialFile: required("T3_ROTATOR_CREDENTIAL_FILE"),
      daemonLabel: NodeProcess.env.T3_DAEMON_CREDENTIAL_LABEL?.trim() || "t3-slack-daemon",
      rotatorLabel: NodeProcess.env.T3_ROTATOR_CREDENTIAL_LABEL?.trim() || "t3-slack-rotator",
      rotateBeforeDays: positiveInteger("T3_CREDENTIAL_ROTATE_BEFORE_DAYS", 10),
      dryRun: NodeProcess.argv.includes("--dry-run"),
    },
    operations,
  );
}

try {
  await main();
} catch (cause) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "slack.rotation.failed",
      category: cause instanceof RotationHttpError ? `http_${cause.status}` : "operation_failed",
      message: cause instanceof Error ? cause.message : "Credential rotation failed.",
    }),
  );
  NodeProcess.exit(1);
}
