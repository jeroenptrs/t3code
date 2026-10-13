import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

const layerTest = (config: JiraConfig | undefined) =>
  JiraBranchLinkService.layer.pipe(
    Layer.provide(Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(config))),
    Layer.provideMerge(layerOrchestration("jira-branch-links")),
  );

const linkSummary = (threadId: ThreadId) =>
  Effect.map(threadLinks(threadId), (links) =>
    links.map((link) => [link.site, link.key, link.source] as const),
  );

it.effect("links the key a branch names, once, and leaves linked and dismissed keys alone", () =>
  Effect.gen(function* () {
    const service = yield* JiraBranchLinkService.JiraBranchLinkService;
    const named = ThreadId.make("thread:named");
    const linked = ThreadId.make("thread:linked");
    const dismissed = ThreadId.make("thread:dismissed");
    const ambiguous = ThreadId.make("thread:ambiguous");
    const plain = ThreadId.make("thread:plain");
    const archived = ThreadId.make("thread:archived");
    yield* createThread(named, "feature/abc-12-login");
    yield* createThread(linked, "ABC-13-fix");
    yield* linkIssue(linked, "ABC-13", "manual");
    yield* createThread(dismissed, "ABC-14");
    yield* linkIssue(dismissed, "ABC-14", "branch");
    yield* unlinkIssue(dismissed, "ABC-14");
    yield* createThread(ambiguous, "abc-1-and-abc-2");
    yield* createThread(plain, "main");
    yield* createThread(archived, "ABC-15");
    yield* archiveThread(archived);

    yield* service.scan(null);
    assert.deepStrictEqual(yield* linkSummary(named), [[SITE, "ABC-12", "branch"]]);
    assert.deepStrictEqual(yield* linkSummary(linked), [[SITE, "ABC-13", "manual"]]);
    assert.deepStrictEqual(yield* linkSummary(dismissed), [[SITE, "ABC-14", "branch-dismissed"]]);
    assert.deepStrictEqual(yield* linkSummary(ambiguous), []);
    assert.deepStrictEqual(yield* linkSummary(plain), []);
    assert.deepStrictEqual(yield* linkSummary(archived), []);
    assert.deepStrictEqual(yield* jiraCommandIds("server:jira-branch-link:"), [
      `server:jira-branch-link:${named}:${SITE}:ABC-12`,
    ]);

    // The next pass finds everything linked and sends nothing.
    yield* service.scan(null);
    assert.lengthOf(yield* jiraCommandIds("server:jira-branch-link:"), 1);
  }).pipe(Effect.provide(layerTest(jiraConfig))),
);

it.effect("scans one thread after its branch changes", () =>
  Effect.gen(function* () {
    const service = yield* JiraBranchLinkService.JiraBranchLinkService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:renamed");
    yield* createThread(threadId, "main");
    yield* service.scan(threadId);
    assert.deepStrictEqual(yield* linkSummary(threadId), []);

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("test:branch"),
      threadId,
      branch: "jeroen/ops-7-rotate-keys",
    });
    yield* service.scan(threadId);
    assert.deepStrictEqual(yield* linkSummary(threadId), [[SITE, "OPS-7", "branch"]]);
  }).pipe(Effect.provide(layerTest(jiraConfig))),
);

it.effect("does nothing while Jira is unconfigured", () =>
  Effect.gen(function* () {
    const service = yield* JiraBranchLinkService.JiraBranchLinkService;
    const threadId = ThreadId.make("thread:unconfigured");
    yield* createThread(threadId, "ABC-16");
    yield* service.scan(null);
    assert.deepStrictEqual(yield* linkSummary(threadId), []);
  }).pipe(Effect.provide(layerTest(undefined))),
);
