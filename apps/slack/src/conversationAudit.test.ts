import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeConversationStartAuditLog } from "./conversationAudit.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("Slack conversation start audit log", () => {
  it("appends complete JSON Lines records in call order", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-slack-audit-"));
    temporaryDirectories.push(directory);
    const filePath = NodePath.join(directory, "nested", "starts.jsonl");
    const log = makeConversationStartAuditLog(filePath);
    const first = {
      version: 1 as const,
      recordedAt: "2026-08-03T08:00:00.000Z",
      slack: { teamId: "T1", userId: "U1" },
      surface: "slash",
      threadId: "thread-1",
      prompt: "Inspect CI",
      configuration: null,
    };
    const second = {
      ...first,
      recordedAt: "2026-08-03T08:01:00.000Z",
      threadId: "thread-2",
      prompt: "Fix CI",
    };

    await Promise.all([log.append(first), log.append(second)]);

    const lines = (await NodeFSP.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([first, second]);
    expect((await NodeFSP.stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
