import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  JiraError,
  ThreadId,
  type JiraIssueSummary,
  type JiraStatusCategory,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as JiraIdentities from "./JiraIdentities.ts";
import * as JiraIssueSyncReactor from "./JiraIssueSyncReactor.ts";
import {
  OTHER_SITE,
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

interface FakeIssue {
  readonly summary: string;
  readonly statusCategory: JiraStatusCategory;
}

const toSummary = (site: string, key: string, issue: FakeIssue): JiraIssueSummary => ({
  site,
  key,
  url: `https://${site}/browse/${key}`,
  summary: issue.summary,
  status: issue.statusCategory,
  statusCategory: issue.statusCategory,
  issueType: null,
  priority: null,
  assignee: null,
  sprints: [],
  storyPoints: null,
  updated: null,
});

/** A Jira that answers from `issues` by site and key, recording every batched read. */
const makeJira = () => {
  const issues = new Map<string, FakeIssue>();
  const failingSites = new Set<string>();
  const calls: Array<{ readonly site: string; readonly keys: ReadonlyArray<string> }> = [];
  const layer = Layer.mock(JiraService.JiraService)({
    issuesByKeys: (site, keys) =>
      Effect.suspend(() => {
        calls.push({ site, keys: keys.toSorted() });
        if (failingSites.has(site)) {
          return Effect.fail(new JiraError({ reason: "unavailable", message: "Jira is down." }));
        }
        return Effect.succeed(
          keys.flatMap((key) => {
            const issue = issues.get(`${site}/${key}`);
            return issue === undefined ? [] : [toSummary(site, key, issue)];
          }),
        );
      }),
  });
  return { issues, failingSites, calls, layer };
};

const layerTest = (jira: ReturnType<typeof makeJira>) =>
  JiraIssueSyncReactor.layer.pipe(
    Layer.provide(jira.layer),
    Layer.provide(Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(jiraConfig))),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(layerOrchestration("jira-issue-sync")),
  );

const snapshots = (threadId: ThreadId) =>
  Effect.map(threadLinks(threadId), (links) =>
    links.map((link) => [
      link.key,
      link.snapshot === null ? null : [link.snapshot.summary, link.snapshot.statusCategory],
    ]),
  );

const callsSince = (jira: ReturnType<typeof makeJira>, from: number) =>
  jira.calls.slice(from).toSorted((left, right) => left.site.localeCompare(right.site));

it.effect("reads each site once per sweep and records only snapshots that changed", () => {
  const jira = makeJira();
  jira.issues.set(`${SITE}/ABC-1`, { summary: "Ship it", statusCategory: "in-progress" });
  jira.issues.set(`${SITE}/ABC-3`, { summary: "Archived", statusCategory: "todo" });
  jira.issues.set(`${SITE}/ABC-4`, { summary: "Dismissed", statusCategory: "todo" });
  jira.issues.set(`${OTHER_SITE}/XYZ-1`, { summary: "Elsewhere", statusCategory: "todo" });
  return Effect.gen(function* () {
    const reactor = yield* JiraIssueSyncReactor.JiraIssueSyncReactor;
    const one = ThreadId.make("thread:one");
    const two = ThreadId.make("thread:two");
    const other = ThreadId.make("thread:other");
    const archived = ThreadId.make("thread:archived");
    const dismissed = ThreadId.make("thread:dismissed");
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* createThread(two);
    yield* linkIssue(two, "ABC-1", "agent");
    // Jira does not show ABC-2 to the reader.
    yield* linkIssue(two, "ABC-2", "manual");
    yield* createThread(other);
    yield* linkIssue(other, "XYZ-1", "manual", OTHER_SITE);
    // No identity is configured for this site, so it is never read.
    yield* linkIssue(other, "QQ-1", "manual", "gamma.atlassian.net");
    yield* createThread(archived);
    yield* linkIssue(archived, "ABC-3", "manual");
    yield* archiveThread(archived);
    yield* createThread(dismissed);
    yield* linkIssue(dismissed, "ABC-4", "branch");
    yield* unlinkIssue(dismissed, "ABC-4");

    yield* reactor.sweep;
    assert.deepStrictEqual(callsSince(jira, 0), [
      { site: SITE, keys: ["ABC-1", "ABC-2"] },
      { site: OTHER_SITE, keys: ["XYZ-1"] },
    ]);
    assert.deepStrictEqual(yield* snapshots(one), [["ABC-1", ["Ship it", "in-progress"]]]);
    assert.deepStrictEqual(yield* snapshots(two), [
      ["ABC-1", ["Ship it", "in-progress"]],
      ["ABC-2", null],
    ]);
    assert.deepStrictEqual(yield* snapshots(other), [
      ["XYZ-1", ["Elsewhere", "todo"]],
      ["QQ-1", null],
    ]);
    assert.deepStrictEqual(yield* snapshots(archived), [["ABC-3", null]]);
    assert.deepStrictEqual(yield* snapshots(dismissed), [["ABC-4", null]]);
    assert.lengthOf(yield* jiraCommandIds("server:jira-sync:"), 3);

    // Nothing changed in Jira: the sweep reads again but records nothing.
    yield* reactor.sweep;
    assert.lengthOf(jira.calls, 4);
    assert.lengthOf(yield* jiraCommandIds("server:jira-sync:"), 3);

    jira.issues.set(`${SITE}/ABC-1`, { summary: "Ship it", statusCategory: "done" });
    yield* reactor.sweep;
    assert.deepStrictEqual(yield* snapshots(one), [["ABC-1", ["Ship it", "done"]]]);
    assert.lengthOf(yield* jiraCommandIds("server:jira-sync:"), 5);
  }).pipe(Effect.provide(layerTest(jira)));
});

it.effect("backs off a failing site without holding up the others", () => {
  const jira = makeJira();
  jira.issues.set(`${SITE}/ABC-1`, { summary: "Ship it", statusCategory: "todo" });
  jira.issues.set(`${OTHER_SITE}/XYZ-1`, { summary: "Elsewhere", statusCategory: "todo" });
  jira.failingSites.add(SITE);
  return Effect.gen(function* () {
    const reactor = yield* JiraIssueSyncReactor.JiraIssueSyncReactor;
    const one = ThreadId.make("thread:one");
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* linkIssue(one, "XYZ-1", "manual", OTHER_SITE);
    const siteReads = () => jira.calls.filter((call) => call.site === SITE).length;

    yield* reactor.sweep;
    assert.deepStrictEqual(yield* snapshots(one), [
      ["ABC-1", null],
      ["XYZ-1", ["Elsewhere", "todo"]],
    ]);
    assert.strictEqual(siteReads(), 1);

    // The first failure waits one interval, the second two.
    yield* reactor.sweep;
    assert.strictEqual(siteReads(), 1);
    yield* TestClock.adjust("2 minutes");
    yield* reactor.sweep;
    assert.strictEqual(siteReads(), 2);

    jira.failingSites.delete(SITE);
    yield* TestClock.adjust("2 minutes");
    yield* reactor.sweep;
    assert.strictEqual(siteReads(), 2);
    yield* TestClock.adjust("2 minutes");
    yield* reactor.sweep;
    assert.strictEqual(siteReads(), 3);
    assert.deepStrictEqual(yield* snapshots(one), [
      ["ABC-1", ["Ship it", "todo"]],
      ["XYZ-1", ["Elsewhere", "todo"]],
    ]);
  }).pipe(Effect.provide(layerTest(jira)));
});
