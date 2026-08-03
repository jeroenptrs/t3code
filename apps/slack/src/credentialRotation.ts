import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { hasExactScopes } from "./scopes.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const DAEMON_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
export const ROTATOR_SCOPES = [
  "access:read",
  "access:write",
  "orchestration:read",
  "orchestration:operate",
] as const;

export interface RotationSession {
  readonly sessionId?: string;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: string;
  readonly label?: string;
  readonly current?: boolean;
}

export function decodeRotationSession(value: unknown): RotationSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("T3 returned an invalid session.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.scopes) || !record.scopes.every((scope) => typeof scope === "string")) {
    throw new Error("T3 returned invalid session scopes.");
  }
  if (typeof record.expiresAt !== "string" || !record.expiresAt) {
    throw new Error("T3 returned an invalid session expiry.");
  }
  const client =
    typeof record.client === "object" && record.client !== null && !Array.isArray(record.client)
      ? (record.client as Record<string, unknown>)
      : null;
  return {
    scopes: record.scopes as ReadonlyArray<string>,
    expiresAt: record.expiresAt,
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(typeof client?.label === "string" ? { label: client.label } : {}),
    ...(typeof record.current === "boolean" ? { current: record.current } : {}),
  };
}

export interface CredentialRotationOperations {
  readonly readCredential: (file: string) => Promise<string>;
  readonly replaceCredential: (file: string, credential: string) => Promise<void>;
  readonly inspectSession: (credential: string) => Promise<RotationSession | null>;
  readonly listSessions: (rotatorCredential: string) => Promise<ReadonlyArray<RotationSession>>;
  readonly issueSession: (
    rotatorCredential: string,
    label: string,
    scopes: ReadonlyArray<string>,
  ) => Promise<{ readonly credential: string; readonly session: RotationSession }>;
  readonly revokeSession: (rotatorCredential: string, sessionId: string) => Promise<void>;
  readonly restartDaemon: () => Promise<void>;
  readonly waitUntilReady: () => Promise<void>;
  readonly log: (level: "info" | "warn", event: string, fields?: Record<string, unknown>) => void;
}

export interface CredentialRotationConfig {
  readonly daemonCredentialFile: string;
  readonly rotatorCredentialFile: string;
  readonly daemonLabel: string;
  readonly rotatorLabel: string;
  readonly rotateBeforeDays: number;
  readonly dryRun: boolean;
  readonly now?: () => number;
}

const isDue = (session: RotationSession | null, now: number, rotateBeforeDays: number): boolean =>
  session === null ||
  !Number.isFinite(Date.parse(session.expiresAt)) ||
  Date.parse(session.expiresAt) - now <= rotateBeforeDays * DAY_MS;

const daysRemaining = (session: RotationSession | null, now: number): number | null =>
  session === null || !Number.isFinite(Date.parse(session.expiresAt))
    ? null
    : Math.max(0, Math.floor((Date.parse(session.expiresAt) - now) / DAY_MS));

const assertSession = (
  session: RotationSession | null,
  expectedScopes: ReadonlyArray<string>,
  subject: string,
  now: number,
): RotationSession => {
  if (session === null) throw new Error(`${subject} credential is not authenticated.`);
  if (!hasExactScopes(session.scopes, expectedScopes)) {
    throw new Error(`${subject} credential does not have the exact required scopes.`);
  }
  if (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now) {
    throw new Error(`${subject} credential is expired or has an invalid expiry.`);
  }
  return session;
};

export async function rotateSlackCredentials(
  config: CredentialRotationConfig,
  operations: CredentialRotationOperations,
): Promise<void> {
  const now = (config.now ?? Date.now)();
  const [rotatorCredential, daemonCredential] = await Promise.all([
    operations.readCredential(config.rotatorCredentialFile),
    operations.readCredential(config.daemonCredentialFile),
  ]);
  const rotatorSession = assertSession(
    await operations.inspectSession(rotatorCredential),
    ROTATOR_SCOPES,
    "Rotator",
    now,
  );
  const daemonSession = await operations.inspectSession(daemonCredential);
  const daemonScopeMismatch =
    daemonSession !== null && !hasExactScopes(daemonSession.scopes, DAEMON_SCOPES);

  const daemonDue = daemonScopeMismatch || isDue(daemonSession, now, config.rotateBeforeDays);
  const rotatorDue = isDue(rotatorSession, now, config.rotateBeforeDays);
  operations.log("info", "slack.rotation.checked", {
    daemonDue,
    daemonDaysRemaining: daysRemaining(daemonSession, now),
    daemonScopeMismatch,
    rotatorDue,
    rotatorDaysRemaining: daysRemaining(rotatorSession, now),
    dryRun: config.dryRun,
  });
  let listedSessions = await operations.listSessions(rotatorCredential);
  const labelledDaemonSessions = listedSessions.filter(
    (session) => session.label === config.daemonLabel && session.sessionId,
  );
  const activeDaemonCandidates =
    daemonSession === null
      ? []
      : labelledDaemonSessions.filter((session) => session.expiresAt === daemonSession.expiresAt);
  const currentRotator = listedSessions.find((session) => session.current && session.sessionId);
  if (!currentRotator?.sessionId) {
    throw new Error("Unable to identify the current rotator session.");
  }
  if (config.dryRun) {
    operations.log("info", "slack.rotation.dry-run", {
      daemonCleanupCandidates:
        activeDaemonCandidates.length <= 1
          ? labelledDaemonSessions.length - activeDaemonCandidates.length
          : null,
      daemonCleanupAmbiguous: activeDaemonCandidates.length > 1,
      rotatorCleanupCandidates: listedSessions.filter(
        (session) =>
          session.label === config.rotatorLabel &&
          session.sessionId &&
          session.sessionId !== currentRotator.sessionId,
      ).length,
    });
    return;
  }

  const cleanupFailures = new Set<string>();
  const cleanup = async (credential: string, sessions: ReadonlyArray<RotationSession>) => {
    for (const session of sessions) {
      if (!session.sessionId) continue;
      try {
        await operations.revokeSession(credential, session.sessionId);
        cleanupFailures.delete(session.sessionId);
      } catch {
        cleanupFailures.add(session.sessionId);
        operations.log("warn", "slack.rotation.cleanup-failed", {
          sessionId: session.sessionId,
          category: "revocation_failed",
        });
      }
    }
  };

  const daemonCleanupTargets =
    activeDaemonCandidates.length === 1
      ? labelledDaemonSessions.filter(
          (session) => session.sessionId !== activeDaemonCandidates[0]!.sessionId,
        )
      : activeDaemonCandidates.length === 0
        ? labelledDaemonSessions
        : null;
  if (daemonCleanupTargets === null) {
    operations.log("warn", "slack.rotation.cleanup-skipped", {
      category: "active_daemon_session_ambiguous",
      candidates: activeDaemonCandidates.length,
    });
    throw new Error("Unable to identify the active daemon session for safe cleanup.");
  }
  if (daemonCleanupTargets.length > 0 && !daemonDue) {
    await operations.restartDaemon();
    await operations.waitUntilReady();
  }
  await cleanup(rotatorCredential, daemonCleanupTargets);

  await cleanup(
    rotatorCredential,
    listedSessions.filter(
      (session) =>
        session.label === config.rotatorLabel &&
        session.sessionId &&
        session.sessionId !== currentRotator.sessionId,
    ),
  );
  listedSessions = await operations.listSessions(rotatorCredential);

  if (daemonDue) {
    const previousSessionIds = new Set(
      listedSessions.flatMap((session) => (session.sessionId ? [session.sessionId] : [])),
    );
    const replacement = await operations.issueSession(
      rotatorCredential,
      config.daemonLabel,
      DAEMON_SCOPES,
    );
    assertSession(replacement.session, DAEMON_SCOPES, "Replacement daemon", now);
    listedSessions = await operations.listSessions(rotatorCredential);
    const replacementCandidates = listedSessions.filter(
      (session) =>
        session.label === config.daemonLabel &&
        session.sessionId &&
        !previousSessionIds.has(session.sessionId) &&
        session.expiresAt === replacement.session.expiresAt &&
        hasExactScopes(session.scopes, DAEMON_SCOPES),
    );
    if (replacementCandidates.length !== 1) {
      throw new Error("Unable to identify the replacement daemon session safely.");
    }
    const replacementSessionId = replacementCandidates[0]!.sessionId!;
    await operations.replaceCredential(config.daemonCredentialFile, replacement.credential);
    try {
      await operations.restartDaemon();
      await operations.waitUntilReady();
    } catch (cause) {
      await operations.replaceCredential(config.daemonCredentialFile, daemonCredential);
      await operations.restartDaemon().catch(() => undefined);
      await cleanup(rotatorCredential, [replacementCandidates[0]!]);
      operations.log("warn", "slack.rotation.daemon-rolled-back", {
        category: "restart_or_readiness_failed",
      });
      throw new Error("Daemon credential rotation failed readiness and was rolled back.", {
        cause,
      });
    }
    const previousSessions = listedSessions.filter(
      (session) =>
        session.label === config.daemonLabel &&
        session.sessionId &&
        session.sessionId !== replacementSessionId,
    );
    await cleanup(rotatorCredential, previousSessions);
    operations.log("info", "slack.rotation.daemon-complete", {
      revokedSessions: previousSessions.length,
      expiresAt: replacement.session.expiresAt,
    });
  }

  if (rotatorDue) {
    const replacement = await operations.issueSession(
      rotatorCredential,
      config.rotatorLabel,
      ROTATOR_SCOPES,
    );
    assertSession(replacement.session, ROTATOR_SCOPES, "Replacement rotator", now);
    await operations.replaceCredential(config.rotatorCredentialFile, replacement.credential);
    await cleanup(replacement.credential, [currentRotator]);
    operations.log("info", "slack.rotation.rotator-complete", {
      expiresAt: replacement.session.expiresAt,
    });
  }

  if (cleanupFailures.size > 0) {
    throw new Error(`Credential rotation left ${cleanupFailures.size} session cleanup pending.`);
  }
}

export async function replaceCredentialFile(file: string, credential: string): Promise<void> {
  if (!credential.trim()) throw new Error("Refusing to write an empty credential.");
  const directory = NodePath.dirname(file);
  const temporary = NodePath.join(
    directory,
    `.${NodePath.basename(file)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  let existing: NodeFS.Stats | null = null;
  try {
    existing = await NodeFSP.stat(file);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  let temporaryHandle: NodeFSP.FileHandle | null = null;
  try {
    temporaryHandle = await NodeFSP.open(temporary, "wx", 0o600);
    await temporaryHandle.writeFile(`${credential.trim()}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    await NodeFSP.chmod(temporary, 0o600);
    if (existing !== null) {
      await NodeFSP.chown(temporary, existing.uid, existing.gid).catch((cause: unknown) => {
        if (typeof NodeProcess.getuid === "function" && NodeProcess.getuid() === existing!.uid)
          return;
        throw cause;
      });
    }
    await NodeFSP.rename(temporary, file);
    try {
      const directoryHandle = await NodeFSP.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // The credential is already atomically committed. Some filesystems do not
      // support directory fsync, and reporting failure here would make callers
      // incorrectly restore or retry a replacement that is already active.
    }
  } catch (cause) {
    await temporaryHandle?.close().catch(() => undefined);
    await NodeFSP.unlink(temporary).catch(() => undefined);
    throw cause;
  }
}
