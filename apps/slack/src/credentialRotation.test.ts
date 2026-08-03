import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  DAEMON_SCOPES,
  ROTATOR_SCOPES,
  decodeRotationSession,
  replaceCredentialFile,
  rotateSlackCredentials,
  type CredentialRotationOperations,
  type RotationSession,
} from "./credentialRotation.ts";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");
const session = (
  scopes: ReadonlyArray<string>,
  expiresAt: string,
  extra: Partial<RotationSession> = {},
): RotationSession => ({ scopes, expiresAt, ...extra });

function fixture(overrides: Partial<CredentialRotationOperations> = {}) {
  const files = new Map([
    ["/daemon", "old-daemon"],
    ["/rotator", "old-rotator"],
  ]);
  let nextSession = 1;
  let sessions: Array<RotationSession> = [
    session(DAEMON_SCOPES, "2026-08-08T00:00:00.000Z", {
      sessionId: "daemon-old-id",
      label: "t3-slack-daemon",
    }),
    session(ROTATOR_SCOPES, "2026-08-08T00:00:00.000Z", {
      sessionId: "rotator-old-id",
      label: "t3-slack-rotator",
      current: true,
    }),
  ];
  const issuedByCredential = new Map<string, RotationSession>();
  const operations: CredentialRotationOperations = {
    readCredential: vi.fn(async (file) => files.get(file)!),
    replaceCredential: vi.fn(async (file, credential) => {
      files.set(file, credential);
      if (file === "/rotator" && credential.includes("new-rotator")) {
        sessions = sessions.map((entry) => ({
          ...entry,
          ...(entry.label === "t3-slack-rotator"
            ? { current: issuedByCredential.get(credential)?.sessionId === entry.sessionId }
            : {}),
        }));
      }
    }),
    inspectSession: vi.fn(async (credential) => {
      const issued = issuedByCredential.get(credential);
      if (issued) return issued;
      return credential.includes("rotator")
        ? session(ROTATOR_SCOPES, "2026-08-08T00:00:00.000Z")
        : session(DAEMON_SCOPES, "2026-08-08T00:00:00.000Z");
    }),
    listSessions: vi.fn(async () => sessions),
    issueSession: vi.fn(async (_credential, label, scopes) => {
      const isRotator = label.includes("rotator");
      const credential = `${isRotator ? "new-rotator" : "new-daemon"}-${nextSession++}`;
      const issued = session(scopes, "2026-09-01T00:00:00.000Z", {
        sessionId: `${label}-${nextSession}`,
        label,
        current: false,
      });
      sessions.push(issued);
      issuedByCredential.set(credential, issued);
      return { credential, session: issued };
    }),
    revokeSession: vi.fn(async (_credential, sessionId) => {
      sessions = sessions.filter((entry) => entry.sessionId !== sessionId);
    }),
    restartDaemon: vi.fn(async () => undefined),
    waitUntilReady: vi.fn(async () => undefined),
    log: vi.fn(),
    ...overrides,
  };
  const config = {
    daemonCredentialFile: "/daemon",
    rotatorCredentialFile: "/rotator",
    daemonLabel: "t3-slack-daemon",
    rotatorLabel: "t3-slack-rotator",
    rotateBeforeDays: 10,
    dryRun: false,
    now: () => NOW,
  };
  return { files, operations, config, sessions: () => sessions };
}

describe("Slack credential rotation", () => {
  it("rotates and verifies the daemon before revoking old sessions, then self-rotates", async () => {
    const { files, operations, config } = fixture();

    await rotateSlackCredentials(config, operations);

    expect(files.get("/daemon")).toMatch(/^new-daemon-/);
    expect(files.get("/rotator")).toMatch(/^new-rotator-/);
    expect(operations.restartDaemon).toHaveBeenCalledOnce();
    expect(operations.waitUntilReady).toHaveBeenCalledOnce();
    expect(operations.revokeSession).toHaveBeenNthCalledWith(1, "old-rotator", "daemon-old-id");
    expect(operations.revokeSession).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^new-rotator-/),
      "rotator-old-id",
    );
  });

  it("rolls back the daemon file and revokes the failed replacement when readiness fails", async () => {
    const { files, operations, config } = fixture({
      waitUntilReady: vi.fn(async () => {
        throw new Error("not ready");
      }),
    });

    await expect(rotateSlackCredentials(config, operations)).rejects.toThrow("rolled back");

    expect(files.get("/daemon")).toBe("old-daemon");
    expect(operations.restartDaemon).toHaveBeenCalledTimes(2);
    expect(operations.revokeSession).toHaveBeenCalledWith("old-rotator", "t3-slack-daemon-2");
  });

  it("does not mutate anything in dry-run mode", async () => {
    const { operations, config } = fixture();

    await rotateSlackCredentials({ ...config, dryRun: true }, operations);

    expect(operations.issueSession).not.toHaveBeenCalled();
    expect(operations.replaceCredential).not.toHaveBeenCalled();
    expect(operations.restartDaemon).not.toHaveBeenCalled();
    expect(operations.revokeSession).not.toHaveBeenCalled();
  });

  it("does not rotate healthy credentials before the window while reconciling stale sessions", async () => {
    const { operations, config } = fixture({
      inspectSession: vi.fn(async (credential) =>
        credential.includes("rotator")
          ? session(ROTATOR_SCOPES, "2026-08-20T00:00:00.000Z")
          : session(DAEMON_SCOPES, "2026-08-20T00:00:00.000Z"),
      ),
    });

    await rotateSlackCredentials(config, operations);

    expect(operations.issueSession).not.toHaveBeenCalled();
    expect(operations.replaceCredential).not.toHaveBeenCalled();
    expect(operations.restartDaemon).toHaveBeenCalledOnce();
    expect(operations.waitUntilReady).toHaveBeenCalledOnce();
    expect(operations.revokeSession).toHaveBeenCalledWith("old-rotator", "daemon-old-id");
    expect(vi.mocked(operations.waitUntilReady).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(operations.revokeSession).mock.invocationCallOrder[0]!,
    );
  });

  it("fails closed when the rotator or replacement scopes are broader than required", async () => {
    const broad = [...ROTATOR_SCOPES, "terminal:operate"];
    const { operations, config } = fixture({
      inspectSession: vi.fn(async (credential) =>
        credential.includes("rotator")
          ? session(broad, "2026-08-08T00:00:00.000Z")
          : session(DAEMON_SCOPES, "2026-08-08T00:00:00.000Z"),
      ),
    });

    await expect(rotateSlackCredentials(config, operations)).rejects.toThrow("exact required");
    expect(operations.issueSession).not.toHaveBeenCalled();
  });

  it("decodes the authoritative nested client label from listed sessions", () => {
    expect(
      decodeRotationSession({
        sessionId: "session-1",
        scopes: [...DAEMON_SCOPES],
        expiresAt: "2026-09-01T00:00:00.000Z",
        current: false,
        client: { label: "t3-slack-daemon", deviceType: "bot" },
      }),
    ).toEqual({
      sessionId: "session-1",
      scopes: [...DAEMON_SCOPES],
      expiresAt: "2026-09-01T00:00:00.000Z",
      current: false,
      label: "t3-slack-daemon",
    });
  });

  it("rotates an existing over-scoped daemon into the exact scope set", async () => {
    const { operations, config } = fixture({
      inspectSession: vi.fn(async (credential) =>
        credential.includes("rotator")
          ? session(ROTATOR_SCOPES, "2026-08-20T00:00:00.000Z")
          : session(
              credential === "old-daemon" ? [...DAEMON_SCOPES, "terminal:operate"] : DAEMON_SCOPES,
              credential === "old-daemon" ? "2026-08-20T00:00:00.000Z" : "2026-09-01T00:00:00.000Z",
            ),
      ),
    });

    await rotateSlackCredentials(config, operations);

    expect(operations.issueSession).toHaveBeenCalledWith(
      "old-rotator",
      "t3-slack-daemon",
      DAEMON_SCOPES,
    );
  });

  it("retries a failed stale-session revocation on the next timer run", async () => {
    const { operations, config, sessions } = fixture();
    const revoke = operations.revokeSession;
    let firstDaemonCleanup = true;
    Object.assign(operations, {
      revokeSession: vi.fn(async (credential: string, sessionId: string) => {
        if (sessionId === "daemon-old-id" && firstDaemonCleanup) {
          firstDaemonCleanup = false;
          throw new Error("temporary revoke failure");
        }
        await revoke(credential, sessionId);
      }),
    });

    await expect(rotateSlackCredentials(config, operations)).rejects.toThrow("cleanup pending");
    expect(sessions().some((entry) => entry.sessionId === "daemon-old-id")).toBe(true);

    await rotateSlackCredentials(config, operations);

    expect(sessions().some((entry) => entry.sessionId === "daemon-old-id")).toBe(false);
  });

  it("atomically replaces a credential with mode 0600 and preserves its owner", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-slack-rotation-"));
    const file = NodePath.join(directory, "daemon.token");
    try {
      await NodeFSP.writeFile(file, "old\n", { mode: 0o640 });
      const before = await NodeFSP.stat(file);

      await replaceCredentialFile(file, "replacement");

      const after = await NodeFSP.stat(file);
      expect(await NodeFSP.readFile(file, "utf8")).toBe("replacement\n");
      expect(after.mode & 0o777).toBe(0o600);
      expect({ uid: after.uid, gid: after.gid }).toEqual({ uid: before.uid, gid: before.gid });
      expect((await NodeFSP.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual(
        [],
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
