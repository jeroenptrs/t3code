import { it as effectIt } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  type JiraIssueInput,
  type ThreadJiraIssueLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createJiraEnvironmentAtoms,
  JIRA_NOT_CONFIGURED,
  jiraIssueUrl,
  parseJiraIssueInput,
  resolveJiraCapabilities,
  visibleThreadJiraIssues,
} from "./jira.ts";

const SITE = "acme.atlassian.net";

describe("parseJiraIssueInput", () => {
  it("puts a bare key on the default site, whatever its case", () => {
    expect(parseJiraIssueInput(" abc-123 ", SITE)).toEqual({ site: SITE, key: "ABC-123" });
    expect(parseJiraIssueInput("AB2-7", "Acme.Atlassian.net")).toEqual({
      site: SITE,
      key: "AB2-7",
    });
  });

  it("accepts underscores in a project key after its first letter", () => {
    expect(parseJiraIssueInput("my_proj-12", SITE)).toEqual({ site: SITE, key: "MY_PROJ-12" });
    expect(parseJiraIssueInput("https://acme.atlassian.net/browse/A_B-3", null)).toEqual({
      site: SITE,
      key: "A_B-3",
    });
    expect(parseJiraIssueInput("_AB-3", SITE)).toBeNull();
  });

  it("refuses a bare key when there is no site to put it on", () => {
    expect(parseJiraIssueInput("ABC-123", null)).toBeNull();
  });

  it("reads browse links, keeping the link's own site", () => {
    expect(parseJiraIssueInput("https://other.atlassian.net/browse/ABC-123", SITE)).toEqual({
      site: "other.atlassian.net",
      key: "ABC-123",
    });
    expect(parseJiraIssueInput("acme.atlassian.net/browse/abc-9?focusedCommentId=1", null)).toEqual(
      { site: SITE, key: "ABC-9" },
    );
  });

  it("reads project issue links and board links with a selected issue", () => {
    expect(
      parseJiraIssueInput(
        "https://acme.atlassian.net/jira/software/c/projects/ABC/issues/ABC-42",
        null,
      ),
    ).toEqual({ site: SITE, key: "ABC-42" });
    expect(
      parseJiraIssueInput(
        "https://acme.atlassian.net/jira/software/c/projects/ABC/boards/1?selectedIssue=ABC-5",
        null,
      ),
    ).toEqual({ site: SITE, key: "ABC-5" });
  });

  it("rejects text and links that name no issue", () => {
    expect(parseJiraIssueInput("", SITE)).toBeNull();
    expect(parseJiraIssueInput("ABC", SITE)).toBeNull();
    expect(parseJiraIssueInput("ABC-0", SITE)).toBeNull();
    expect(parseJiraIssueInput("1BC-3", SITE)).toBeNull();
    expect(parseJiraIssueInput("https://acme.atlassian.net/jira/your-work", SITE)).toBeNull();
    expect(parseJiraIssueInput("https://acme.atlassian.net/browse/", SITE)).toBeNull();
    expect(parseJiraIssueInput("ftp://acme.atlassian.net/browse/ABC-1", SITE)).toBeNull();
  });
});

describe("jiraIssueUrl", () => {
  it("links to the issue's browse page", () => {
    expect(jiraIssueUrl({ site: SITE, key: "ABC-1" })).toBe(
      "https://acme.atlassian.net/browse/ABC-1",
    );
  });
});

describe("visibleThreadJiraIssues", () => {
  const link = (key: string, source: ThreadJiraIssueLink["source"]): ThreadJiraIssueLink => ({
    site: SITE,
    key,
    source,
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: null,
  });

  it("hides dismissed branch links and keeps the rest in order", () => {
    expect(
      visibleThreadJiraIssues([
        link("ABC-1", "branch"),
        link("ABC-2", "branch-dismissed"),
        link("ABC-3", "manual"),
        link("ABC-4", "agent"),
      ]).map((entry) => entry.key),
    ).toEqual(["ABC-1", "ABC-3", "ABC-4"]);
    expect(visibleThreadJiraIssues(undefined)).toEqual([]);
  });
});

describe("resolveJiraCapabilities", () => {
  const configured = { ...JIRA_NOT_CONFIGURED, configured: true };

  it("is unknown until the server first answers", () => {
    expect(resolveJiraCapabilities(AsyncResult.initial(true))).toBeNull();
  });

  it("treats a failure, such as a server that predates Jira, as not configured", () => {
    expect(resolveJiraCapabilities(AsyncResult.failure(Cause.die("unknown method")))).toEqual(
      JIRA_NOT_CONFIGURED,
    );
  });

  it("keeps the last answer through a later failure", () => {
    const previous = Option.some(AsyncResult.success(configured));
    expect(
      resolveJiraCapabilities(AsyncResult.failureWithPrevious(Cause.die("offline"), { previous })),
    ).toEqual(configured);
  });
});

describe("Jira issue reads", () => {
  const TARGET = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("jira-environment"),
    label: "Jira environment",
    httpBaseUrl: "https://jira-environment.example.test",
    wsBaseUrl: "wss://jira-environment.example.test",
  });

  effectIt.effect("skip the server's cache only for an explicit refresh", () =>
    Effect.gen(function* () {
      const sent: Array<JiraIssueInput> = [];
      const client = {
        [WS_METHODS.jiraIssue]: (input: JiraIssueInput) =>
          Effect.sync(() => {
            sent.push(input);
            return { site: input.site, key: input.key };
          }),
      } as unknown as WsRpcProtocolClient;
      const session = { client } as unknown as RpcSession;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
        _id,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        followStream,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const atoms = createJiraEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
      );
      const registry = AtomRegistry.make();
      const target = {
        environmentId: TARGET.environmentId,
        input: { site: SITE, key: "ABC-1" },
      };
      const atom = atoms.issue(target);
      const unmount = registry.mount(atom);
      const settled = AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });

      yield* settled;
      registry.refresh(atom);
      yield* settled;
      atoms.refreshIssue(registry, target);
      yield* settled;
      registry.refresh(atom);
      yield* settled;

      expect(sent).toEqual([
        { site: SITE, key: "ABC-1" },
        { site: SITE, key: "ABC-1" },
        { site: SITE, key: "ABC-1", refresh: true },
        { site: SITE, key: "ABC-1" },
      ]);
      unmount();
      registry.dispose();
    }),
  );
});
