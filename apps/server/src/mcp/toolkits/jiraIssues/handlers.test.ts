import {
  EnvironmentId,
  JiraError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type JiraIssueSummary,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  type ThreadJiraIssueLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import type { JiraConfig } from "../../../jira/JiraConfig.ts";
import * as JiraIdentities from "../../../jira/JiraIdentities.ts";
import * as JiraProposals from "../../../jira/JiraProposals.ts";
import { jiraConfig, OTHER_SITE, SITE } from "../../../jira/JiraLinks.testkit.ts";
import * as JiraService from "../../../jira/JiraService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as JiraIssuesHandlers from "./handlers.ts";
import { JiraIssuesToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-1");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
};

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const makeLink = (
  key: string,
  overrides: Partial<ThreadJiraIssueLink> = {},
): ThreadJiraIssueLink => ({
  site: SITE,
  key,
  source: "manual",
  linkedAt: "2026-10-01T00:00:00.000Z",
  snapshot: null,
  ...overrides,
});

const issue = (key: string, summary: string): JiraIssueSummary => ({
  site: SITE,
  key,
  url: `https://${SITE}/browse/${key}`,
  summary,
  status: "In Progress",
  statusCategory: "in-progress",
  issueType: "Story",
  priority: null,
  assignee: null,
  sprints: [],
  storyPoints: null,
  updated: null,
});

interface HarnessOptions {
  readonly links?: ReadonlyArray<ThreadJiraIssueLink>;
  readonly config?: JiraConfig | undefined;
  readonly issuesByKeys?: JiraService.JiraService["Service"]["issuesByKeys"];
  readonly subagent?: boolean;
}

const WATCH = {
  startedAt: "2026-10-01T00:00:00.000Z",
  updatedThrough: null,
  statusCategory: null,
  assigneeAccountId: null,
  commentsThrough: "2026-10-01T00:00:00.000Z",
  wakes: 0,
};

/** What the orchestrator does with a watch command, enough for the tool to read back. */
const applyWatch = (
  links: ReadonlyArray<ThreadJiraIssueLink>,
  command: Extract<OrchestrationCommand, { type: "thread.jira-issue.watch" }>,
): ReadonlyArray<ThreadJiraIssueLink> => {
  const matches = (link: ThreadJiraIssueLink) =>
    link.site === command.site && link.key === command.key && link.source !== "branch-dismissed";
  if (!command.watching) {
    return links.map((link) => (matches(link) ? { ...link, watch: undefined } : link));
  }
  return links.some(matches)
    ? links.map((link) => (matches(link) ? { ...link, watch: link.watch ?? WATCH } : link))
    : [...links, makeLink(command.key, { site: command.site, source: "agent", watch: WATCH })];
};

const makeHarness = Effect.fn("makeJiraIssuesToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const thread = {
    ...v2PullRequestThread({
      id: THREAD_ID,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestUserMessageAt: null,
      ...(options.subagent
        ? {
            lineage: {
              rootThreadId: ThreadId.make("thread-root"),
              parentThreadId: ThreadId.make("thread-root"),
              relationshipToParent: "subagent" as const,
            },
          }
        : {}),
    }),
    jiraIssues: options.links ?? [],
  };
  let current = thread;
  const layerDependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) => Effect.sync(() => (id === THREAD_ID ? current : null)),
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (command.type === "thread.jira-issue.watch") {
                current = { ...current, jiraIssues: applyWatch(current.jiraIssues, command) };
              }
            }),
          ),
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.mock(JiraService.JiraService)({
      issuesByKeys: options.issuesByKeys ?? (() => Effect.succeed([])),
    }),
    Layer.succeed(
      JiraIdentities.JiraIdentities,
      JiraIdentities.make("config" in options ? options.config : jiraConfig),
    ),
    Layer.mock(JiraProposals.JiraProposals)({}),
    Layer.succeed(Crypto.Crypto, testCrypto),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* JiraIssuesToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(JiraIssuesHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof JiraIssuesToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof JiraIssuesToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provide(layerDependencies),
    );
  return { commands, call };
});

describe("Jira issue toolkit handlers", () => {
  it.effect("links on the reader's site as the agent and reports the issue", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        issuesByKeys: (site, keys) =>
          Effect.succeed(site === SITE && keys.includes("ABC-1") ? [issue("ABC-1", "Login")] : []),
      });
      const result = yield* harness.call("link_jira_issue", { key: "ABC-1" });
      expect(result).toEqual({
        site: SITE,
        key: "ABC-1",
        url: `https://${SITE}/browse/ABC-1`,
        alreadyLinked: false,
        issue: { summary: "Login", status: "In Progress", statusCategory: "in-progress" },
        note: null,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.jira-issue.link",
          threadId: THREAD_ID,
          site: SITE,
          key: "ABC-1",
          source: "agent",
        },
      ]);
      expect((yield* Ref.get(harness.commands))[0]).not.toHaveProperty("linkedByUserId");
    }),
  );

  it.effect("links even when Jira cannot read the issue, and skips a link it already has", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        links: [makeLink("ABC-2", { site: OTHER_SITE })],
        issuesByKeys: () =>
          Effect.fail(new JiraError({ reason: "unavailable", message: "Jira is down." })),
      });
      expect(
        yield* harness.call("link_jira_issue", {
          key: "ABC-2",
          site: "https://Beta.atlassian.net",
        }),
      ).toMatchObject({
        site: OTHER_SITE,
        alreadyLinked: true,
        issue: null,
        note: "Jira is down.",
      });
      expect(yield* harness.call("link_jira_issue", { key: "ABC-3" })).toMatchObject({
        site: SITE,
        alreadyLinked: false,
        issue: null,
        note: "Jira is down.",
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([{ key: "ABC-3", site: SITE }]);
    }),
  );

  it.effect("refuses to link without a site while Jira is unconfigured", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ config: undefined });
      const error = yield* harness.call("link_jira_issue", { key: "ABC-1" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "JiraNotConfiguredError" });
      expect(error.message).toContain("Jira is not configured on this server");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("unlinks a linked issue on its own site, even while Jira is unconfigured", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        config: undefined,
        links: [
          makeLink("ABC-4", { site: OTHER_SITE }),
          makeLink("ABC-5", { source: "branch-dismissed" }),
        ],
      });
      expect(yield* harness.call("unlink_jira_issue", { key: "ABC-4" })).toEqual({
        site: OTHER_SITE,
        key: "ABC-4",
        wasLinked: true,
      });
      // A tombstone, left by any earlier unlink, is already unlinked.
      expect(yield* harness.call("unlink_jira_issue", { key: "ABC-5" })).toEqual({
        site: null,
        key: "ABC-5",
        wasLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.jira-issue.unlink", threadId: THREAD_ID, site: OTHER_SITE, key: "ABC-4" },
      ]);
    }),
  );

  it.effect("lists visible links with their last read summary", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        config: undefined,
        links: [
          makeLink("ABC-6", {
            source: "branch",
            snapshot: {
              summary: "Rotate keys",
              statusCategory: "done",
              syncedAt: "2026-10-02T00:00:00.000Z",
            },
          }),
          makeLink("ABC-7"),
          makeLink("ABC-8", { source: "branch-dismissed" }),
        ],
      });
      expect(yield* harness.call("list_thread_jira_issues", {})).toEqual({
        issues: [
          {
            site: SITE,
            key: "ABC-6",
            url: `https://${SITE}/browse/ABC-6`,
            source: "branch",
            linkedAt: "2026-10-01T00:00:00.000Z",
            summary: "Rotate keys",
            statusCategory: "done",
            syncedAt: "2026-10-02T00:00:00.000Z",
          },
          {
            site: SITE,
            key: "ABC-7",
            url: `https://${SITE}/browse/ABC-7`,
            source: "manual",
            linkedAt: "2026-10-01T00:00:00.000Z",
            summary: null,
            statusCategory: null,
            syncedAt: null,
          },
        ],
      });
    }),
  );

  it.effect("watches as the agent, linking the issue on the reader's site when needed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call("watch_jira_issue", { key: "ABC-1" })).toEqual({
        site: SITE,
        key: "ABC-1",
        watching: true,
        wasWatching: false,
      });
      // Watching again changes nothing the agent can see.
      expect(yield* harness.call("watch_jira_issue", { key: "ABC-1" })).toMatchObject({
        watching: true,
        wasWatching: true,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.jira-issue.watch", site: SITE, key: "ABC-1", watching: true },
        { type: "thread.jira-issue.watch", watching: true, linkSource: "agent" },
      ]);
      expect((yield* Ref.get(harness.commands))[0]).toMatchObject({ linkSource: "agent" });
      expect((yield* Ref.get(harness.commands))[0]).not.toHaveProperty("linkedByUserId");
    }),
  );

  it.effect("watches and unwatches the site the thread already links the key on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ links: [makeLink("ABC-2", { site: OTHER_SITE })] });
      expect(yield* harness.call("watch_jira_issue", { key: "ABC-2" })).toMatchObject({
        site: OTHER_SITE,
        watching: true,
      });
      expect(yield* harness.call("unwatch_jira_issue", { key: "ABC-2" })).toEqual({
        site: OTHER_SITE,
        key: "ABC-2",
        watching: false,
        wasWatching: true,
      });
      // Unwatching what is not watched sends nothing.
      expect(yield* harness.call("unwatch_jira_issue", { key: "ABC-2" })).toMatchObject({
        watching: false,
        wasWatching: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.jira-issue.watch", site: OTHER_SITE, watching: true },
        { type: "thread.jira-issue.watch", site: OTHER_SITE, watching: false },
      ]);
    }),
  );

  it.effect("refuses to watch from a subagent or where T3 Code does not read Jira", () =>
    Effect.gen(function* () {
      const subagent = yield* makeHarness({ subagent: true });
      expect(
        yield* subagent.call("watch_jira_issue", { key: "ABC-3" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "JiraIssueWatchFromSubagentError" });

      const elsewhere = yield* makeHarness();
      expect(
        yield* elsewhere
          .call("watch_jira_issue", { key: "ABC-3", site: "gamma.atlassian.net" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "JiraIssueWatchUnavailableError", site: "gamma.atlassian.net" });

      const unconfigured = yield* makeHarness({ config: undefined });
      expect(
        yield* unconfigured.call("watch_jira_issue", { key: "ABC-3" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "JiraIssueWatchUnavailableError", site: null });
      for (const harness of [subagent, elsewhere, unconfigured]) {
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }
    }),
  );
});
