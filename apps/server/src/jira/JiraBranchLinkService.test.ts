import { assert, it } from "@effect/vitest";
import { CommandId, JiraError, ThreadId, type JiraIssueSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { JiraConfig } from "./JiraConfig.ts";
import * as JiraBranchLinkService from "./JiraBranchLinkService.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import {
  SITE,
  archiveThread,
  createThread,
  jiraCommandIds,
  jiraConfig,
  layerOrchestration,
  linkIssue,
  threadLinks,
  unlinkIssue,
} from "./JiraLinks.testkit.ts";
import * as JiraService from "./JiraService.ts";

const toSummary = (key: string): JiraIssueSummary => ({
  site: SITE,
  key,
  url: `https://${SITE}/browse/${key}`,
  summary: key,
  status: "To Do",
  statusCategory: "todo",
  issueType: null,
  parentKey: null,
  priority: null,
  assignee: null,
  sprints: [],
  storyPoints: null,
  updated: null,
});

/** A Jira whose issues map an asked key to the key it answers under, recording every read. */
const makeJira = (issues: Record<string, string>) => {
  const state = { failing: false, calls: [] as Array<ReadonlyArray<string>> };
  const layer = Layer.mock(JiraService.JiraService)({
    issuesByKeys: (_site, keys) =>
      Effect.suspend(() => {
        state.calls.push(keys.toSorted());
        if (state.failing) {
          return Effect.fail(new JiraError({ reason: "unavailable", message: "Jira is down." }));
        }
        return Effect.succeed(
          keys.flatMap((key) => (issues[key] === undefined ? [] : [toSummary(issues[key])])),
        );
      }),
  });
  return { state, layer };
};

const layerTest = (config: JiraConfig | undefined, jira: ReturnType<typeof makeJira>) =>
  JiraBranchLinkService.layer.pipe(
    Layer.provide(jira.layer),
    Layer.provide(Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(config))),
    Layer.provideMerge(layerOrchestration("jira-branch-links")),
  );

const linkSummary = (threadId: ThreadId) =>
  Effect.map(threadLinks(threadId), (links) =>
    links.map((link) => [link.site, link.key, link.source] as const),
  );

it.effect(
  "links branch keys Jira confirms, once, and leaves linked and dismissed keys alone",
  () => {
    const jira = makeJira({ "ABC-12": "ABC-12", "ABC-17": "ABC-17" });
    return Effect.gen(function* () {
      const service = yield* JiraBranchLinkService.JiraBranchLinkService;
      const named = ThreadId.make("thread:named");
      const linked = ThreadId.make("thread:linked");
      const dismissed = ThreadId.make("thread:dismissed");
      const bogus = ThreadId.make("thread:bogus");
      const plain = ThreadId.make("thread:plain");
      const archived = ThreadId.make("thread:archived");
      const later = ThreadId.make("thread:later");
      yield* createThread(named, "feature/abc-12-login");
      yield* createThread(linked, "ABC-13-fix");
      yield* linkIssue(linked, "ABC-13", "manual");
      yield* createThread(dismissed, "ABC-14");
      yield* linkIssue(dismissed, "ABC-14", "manual");
      yield* unlinkIssue(dismissed, "ABC-14");
      yield* createThread(bogus, "gh-1234-bump-node");
      yield* createThread(plain, "main");
      yield* createThread(archived, "ABC-15");
      yield* archiveThread(archived);

      yield* service.scan(null);
      // One read for the pass, with only the keys that might still need a link.
      assert.deepStrictEqual(jira.state.calls, [["ABC-12", "GH-1234"]]);
      assert.deepStrictEqual(yield* linkSummary(named), [[SITE, "ABC-12", "branch"]]);
      assert.deepStrictEqual(yield* linkSummary(linked), [[SITE, "ABC-13", "manual"]]);
      assert.deepStrictEqual(yield* linkSummary(dismissed), [[SITE, "ABC-14", "branch-dismissed"]]);
      assert.deepStrictEqual(yield* linkSummary(bogus), []);
      assert.deepStrictEqual(yield* linkSummary(plain), []);
      assert.deepStrictEqual(yield* linkSummary(archived), []);
      assert.deepStrictEqual(yield* jiraCommandIds("server:jira-branch-link:"), [
        `server:jira-branch-link:${named}:${SITE}:ABC-12`,
      ]);

      // The next pass finds everything linked or known missing and asks Jira nothing.
      yield* service.scan(null);
      assert.lengthOf(jira.state.calls, 1);
      assert.lengthOf(yield* jiraCommandIds("server:jira-branch-link:"), 1);

      // A new key is asked about alone; the missing one waits out its hour.
      yield* createThread(later, "abc-17-bump-react-to-19");
      yield* service.scan(null);
      assert.deepStrictEqual(jira.state.calls[1], ["ABC-17"]);
      assert.deepStrictEqual(yield* linkSummary(later), [[SITE, "ABC-17", "branch"]]);

      yield* TestClock.adjust("1 hour");
      yield* service.scan(null);
      assert.deepStrictEqual(jira.state.calls.slice(2), [["GH-1234"]]);
      assert.deepStrictEqual(yield* linkSummary(bogus), []);
    }).pipe(Effect.provide(layerTest(jiraConfig, jira)));
  },
);

it.effect("links the key a moved issue answers under", () => {
  const jira = makeJira({ "OLD-5": "NEW-9" });
  return Effect.gen(function* () {
    const service = yield* JiraBranchLinkService.JiraBranchLinkService;
    const threadId = ThreadId.make("thread:moved");
    yield* createThread(threadId, "old-5-rename");
    yield* service.scan(null);
    assert.deepStrictEqual(yield* linkSummary(threadId), [[SITE, "NEW-9", "branch"]]);

    // The move is remembered, so another thread on the old key links without asking again.
    const other = ThreadId.make("thread:moved-too");
    yield* createThread(other, "OLD-5");
    yield* service.scan(other);
    assert.deepStrictEqual(yield* linkSummary(other), [[SITE, "NEW-9", "branch"]]);
    assert.lengthOf(jira.state.calls, 1);
  }).pipe(Effect.provide(layerTest(jiraConfig, jira)));
});

it.effect("links nothing while Jira fails and retries on the next pass", () => {
  const jira = makeJira({ "ABC-20": "ABC-20" });
  return Effect.gen(function* () {
    const service = yield* JiraBranchLinkService.JiraBranchLinkService;
    const threadId = ThreadId.make("thread:failing");
    yield* createThread(threadId, "abc-20");
    jira.state.failing = true;
    yield* service.scan(null);
    assert.deepStrictEqual(yield* linkSummary(threadId), []);

    jira.state.failing = false;
    yield* service.scan(null);
    assert.lengthOf(jira.state.calls, 2);
    assert.deepStrictEqual(yield* linkSummary(threadId), [[SITE, "ABC-20", "branch"]]);
  }).pipe(Effect.provide(layerTest(jiraConfig, jira)));
});

it.effect("scans one thread after its branch changes", () => {
  const jira = makeJira({ "OPS-7": "OPS-7" });
  return Effect.gen(function* () {
    const service = yield* JiraBranchLinkService.JiraBranchLinkService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:renamed");
    yield* createThread(threadId, "main");
    yield* service.scan(threadId);
    assert.deepStrictEqual(yield* linkSummary(threadId), []);
    assert.lengthOf(jira.state.calls, 0);

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("test:branch"),
      threadId,
      branch: "jeroen/ops-7-rotate-keys",
    });
    yield* service.scan(threadId);
    assert.deepStrictEqual(yield* linkSummary(threadId), [[SITE, "OPS-7", "branch"]]);
  }).pipe(Effect.provide(layerTest(jiraConfig, jira)));
});

it.effect("does nothing while Jira is unconfigured", () => {
  const jira = makeJira({ "ABC-16": "ABC-16" });
  return Effect.gen(function* () {
    const service = yield* JiraBranchLinkService.JiraBranchLinkService;
    const threadId = ThreadId.make("thread:unconfigured");
    yield* createThread(threadId, "ABC-16");
    yield* service.scan(null);
    assert.deepStrictEqual(yield* linkSummary(threadId), []);
    assert.lengthOf(jira.state.calls, 0);
  }).pipe(Effect.provide(layerTest(undefined, jira)));
});
