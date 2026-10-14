import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
} from "./presentation.js";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it.each([
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it.each([
    "logs/app.log:12: Error: ENOENT: no such file or directory",
    "fixtures/ci.txt:3: Process exited with exit code 2",
  ])("trusts a zero exit code over failure text in the output and command: %s", (output) => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      tone: "tool",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      command: 'rg -n "ENOENT|exit code" logs fixtures',
      structuredPayload: commandItem({ output, exitCode: 0, outputIndicatesFailure: true }),
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("ignores failure phrases in reasoning text", () => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      toolLifecycleStatus: "completed",
      detail: "That exit code 2 is just from listing the deleted directory, which is expected.",
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);

    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "T3-code.t3_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Failed to clone a repository",
    );
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    const childFailure = {
      ...entry,
      label: "T3-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
  });
  it.each([
    "mcp__t3-code__preview_click",
    "mcp__t3_code__preview_click",
    "mcp__t3code__preview_click",
    "T3-code.preview_click",
    "t3-code · preview_click completed",
    "t3_code/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "t3-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "T3-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "Clicking in the preview browser",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "Clicked in the preview browser",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked in the preview browser");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click in the preview browser");
  });

  it.each([
    ["https://github.com/acme/web/pull/7", "PR #7"],
    ["https://gitlab.com/acme/web/-/merge_requests/7", "MR #7"],
  ])("names a linked change request with its host's term (%s)", (url, target) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "T3-code.link_pull_request",
        toolLifecycleStatus: "completed",
        toolData: { arguments: { url } },
      })?.displayName,
    ).toMatch(new RegExp(` ${target}$`));
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "t3-code.unknown_tool",
      "t3-code.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});

describe("Jira issue tool presentation", () => {
  it.each([
    "mcp__t3-code__link_jira_issue",
    "T3-code · link_jira_issue",
    "t3-code.link_jira_issue",
    "link_jira_issue",
  ])("recognizes the linking tool: %s", (label) => {
    const entry: WorkLogPresentationEntry = {
      id: "link",
      createdAt: "2026-10-14T00:00:00.000Z",
      label,
      tone: "tool",
      toolLifecycleStatus: "completed",
    };
    expect(resolveWorkEntryToolPresentation(entry)).toMatchObject({
      displayName: "Linked a Jira issue",
      icon: "jira",
    });
    expect(toolGroupAction(entry)).toBe("link-jira");
  });

  it.each([
    ["inProgress", "Linking ABC-123"],
    ["completed", "Linked ABC-123"],
    ["failed", "Failed to link ABC-123"],
  ] as const)("names the issue key while %s", (toolLifecycleStatus, displayName) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "MCP tool call",
        toolLifecycleStatus,
        toolData: { server: "t3-code", tool: "link_jira_issue", arguments: { key: "ABC-123" } },
      })?.displayName,
    ).toBe(displayName);
  });

  it("summarizes Jira link work under its own kind", () => {
    const link: WorkLogPresentationEntry = {
      id: "link",
      createdAt: "2026-10-14T00:00:00.000Z",
      label: "T3-code · link_jira_issue",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      toolSource: { key: "t3-code", name: "T3 Code", kind: "integration" },
    };
    const list: WorkLogPresentationEntry = { ...link, label: "T3-code · list_thread_jira_issues" };
    expect(summarizeToolGroup([link, link, list]).summary).toBe(
      "Linked 2 Jira issues and checked linked Jira issues",
    );
    expect(summarizeToolGroup([{ ...link, label: "T3-code · unlink_jira_issue" }]).summary).toBe(
      "Unlinked 1 Jira issue",
    );
    expect(toolGroupSummaryKind([link, link, list])).toBe("jira");
    expect(summarizeToolGroup([list, list]).summary).toBe("Checked linked Jira issues 2 times");
    expect(resolveWorkEntryToolPresentation({ label: "mcp__jira__link_jira_issue" })).toBeNull();
  });
});

describe("Jira proposal tool presentation", () => {
  const proposal = (tool: string, args: unknown): WorkLogPresentationEntry => ({
    id: tool,
    createdAt: "2026-10-14T00:00:00.000Z",
    label: `T3-code · ${tool}`,
    tone: "tool",
    itemType: "dynamic_tool",
    toolLifecycleStatus: "completed",
    toolSource: { key: "t3-code", name: "T3 Code", kind: "integration" },
    toolData: { server: "t3-code", tool, arguments: args },
  });
  const drafts = (count: number) => ({
    issues: Array.from({ length: count }, (_, index) => ({ summary: `Draft ${index}` })),
  });

  it("counts the drafts a proposal carries", () => {
    expect(
      resolveWorkEntryToolPresentation(proposal("propose_jira_issues", drafts(3))),
    ).toMatchObject({ displayName: "Proposed 3 Jira issues", icon: "jira" });
    expect(
      resolveWorkEntryToolPresentation(proposal("propose_jira_issues", drafts(1)))?.displayName,
    ).toBe("Proposed a Jira issue");
    expect(
      resolveWorkEntryToolPresentation({ label: "mcp__t3-code__propose_jira_issues" })?.displayName,
    ).toBe("Proposing Jira issues");
    expect(
      resolveWorkEntryToolPresentation(
        proposal("propose_jira_comment", { key: "ABC-1", body: "Done" }),
      ),
    ).toMatchObject({ displayName: "Proposed a Jira comment", icon: "jira" });
    expect(
      resolveWorkEntryToolPresentation(proposal("propose_jira_transition", { key: "ABC-1" }))
        ?.displayName,
    ).toBe("Proposed a Jira transition");
  });

  it("summarizes proposals by what they ask for", () => {
    const issues = proposal("propose_jira_issues", drafts(2));
    const comment = proposal("propose_jira_comment", { key: "ABC-1", body: "Done" });
    const transition = proposal("propose_jira_transition", { key: "ABC-1" });
    expect(summarizeToolGroup([issues, { ...issues, toolData: undefined }]).summary).toBe(
      "Proposed 3 Jira issues",
    );
    expect(summarizeToolGroup([comment, transition]).summary).toBe(
      "Proposed 1 Jira comment and proposed 1 Jira transition",
    );
    expect(toolGroupSummaryKind([issues, comment, transition])).toBe("jira");
  });
});

describe("Jira watch tool presentation", () => {
  const watchCall = (
    tool: string,
    status: "inProgress" | "completed" | "failed",
    args: unknown = { key: "abc-1" },
  ): WorkLogPresentationEntry => ({
    id: `${tool}-${status}`,
    createdAt: "2026-10-14T00:00:00.000Z",
    label: `T3-code · ${tool}`,
    tone: "tool",
    itemType: "dynamic_tool",
    toolLifecycleStatus: status,
    toolSource: { key: "t3-code", name: "T3 Code", kind: "integration" },
    toolData: { server: "t3-code", tool, arguments: args },
  });

  it("names the issue and the jira icon", () => {
    expect(
      resolveWorkEntryToolPresentation(watchCall("watch_jira_issue", "completed")),
    ).toMatchObject({ displayName: "Watched ABC-1", icon: "jira" });
    expect(
      resolveWorkEntryToolPresentation(watchCall("unwatch_jira_issue", "completed")),
    ).toMatchObject({ displayName: "Stopped watching ABC-1", icon: "jira" });
    expect(
      resolveWorkEntryToolPresentation(watchCall("watch_jira_issue", "inProgress"))?.displayName,
    ).toBe("Watching ABC-1");
    expect(
      resolveWorkEntryToolPresentation(watchCall("watch_jira_issue", "failed"))?.displayName,
    ).toBe("Failed to watch ABC-1");
    expect(
      resolveWorkEntryToolPresentation(watchCall("watch_jira_issue", "completed", {}))?.displayName,
    ).toBe("Watched a Jira issue");
  });

  it("summarizes watches by count", () => {
    const watch = watchCall("watch_jira_issue", "completed");
    const unwatch = watchCall("unwatch_jira_issue", "completed");
    expect(summarizeToolGroup([watch, { ...watch, id: "second" }]).summary).toBe(
      "Watched 2 Jira issues",
    );
    expect(summarizeToolGroup([unwatch]).summary).toBe("Stopped watching 1 Jira issue");
    expect(toolGroupSummaryKind([watch, unwatch])).toBe("jira");
  });
});
