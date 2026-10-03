import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import type { IngressInvocation } from "@t3tools/integration-runtime";

export interface ConversationStartConfiguration {
  readonly projectId: string;
  readonly projectLabel: string | null;
  readonly workspace: "current" | "new-worktree";
  readonly branchOption: string | null;
  readonly branchLabel: string | null;
  readonly modelOption: string;
  readonly modelLabel: string | null;
}

export interface ConversationStartAuditRecord {
  readonly version: 1;
  readonly recordedAt: string;
  readonly slack: {
    readonly teamId: string;
    readonly userId: string;
  };
  readonly surface: IngressInvocation["surface"];
  readonly threadId: string;
  readonly prompt: string;
  readonly configuration: ConversationStartConfiguration | null;
}

export interface ConversationStartAuditLog {
  readonly append: (record: ConversationStartAuditRecord) => Promise<void>;
}

export function makeConversationStartAuditLog(filePath: string): ConversationStartAuditLog {
  let pending = Promise.resolve();
  const directory = NodePath.dirname(filePath);

  return {
    append: (record) => {
      const write = pending
        .catch(() => undefined)
        .then(async () => {
          await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
          await NodeFSP.appendFile(filePath, `${JSON.stringify(record)}\n`, {
            encoding: "utf8",
            flag: "a",
            mode: 0o600,
          });
        });
      pending = write;
      return write;
    },
  };
}
