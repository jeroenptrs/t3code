import { describe, expect, it } from "@effect/vitest";
import { JiraError } from "@t3tools/contracts";
import type { StandaloneIssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as IssueTrackerRegistry from "../issue/IssueTrackerRegistry.ts";
import * as JiraApi from "./JiraApi.ts";
import type { JiraConfig } from "./JiraConfig.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

const SITE = "acme.atlassian.net";
const config: JiraConfig = {
  reader: "bot",
  identities: [
    {
      name: "bot",
      site: SITE,
      authMethod: "scoped-token",
      token: Redacted.make("token"),
      cloudId: "cloud-1",
    },
  ],
};

const rawIssue: JiraApi.JiraRawIssue = {
  id: "10001",
  key: "ABC-12",
  fields: {
    summary: "Fix the login",
    status: { name: "Code Review", statusCategory: { key: "indeterminate" } },
    reporter: { accountId: "acc-2", displayName: "Grace" },
    assignee: { accountId: "acc-1", displayName: "Ada", avatarUrls: { "48x48": "https://a/48" } },
    created: "2026-09-30T08:00:00.000+0200",
    updated: "2026-10-01T12:34:56.789+0200",
    resolutiondate: "2026-10-02T09:00:00.000+0000",
    labels: ["backend"],
    description: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Steps" }] }],
    },
  },
};

const rawComment = (id: number): JiraApi.JiraRawComment => ({
  id: String(id),
  author: { accountId: "acc-1", displayName: "Ada" },
  body: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: `c${id}` }] }],
  },
  created: new Date(Date.UTC(2026, 9, 1, 10, 0, id)).toISOString(),
});

/** The tracker over a recorded Jira, on a server with the reader identity. */
const withTracker = <A, E>(
  mock: Partial<JiraApi.JiraApi["Service"]>,
  use: (tracker: StandaloneIssueTrackerApi) => Effect.Effect<A, E>,
) =>
  JiraIssueTracker.registered.pipe(
    Effect.flatMap((trackers) => use(trackers[0]!)),
    Effect.provide(
      Layer.merge(
        Layer.mock(JiraApi.JiraApi)(mock),
        Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(config)),
      ),
    ),
  );
const target = { cwd: "/repo", host: SITE, scope: "ABC" };

describe("JiraIssueTracker", () => {
  it.effect("registers as `jira` only on a server with Jira identities", () =>
    Effect.gen(function* () {
      const registry = (jira: JiraConfig | undefined) =>
        JiraIssueTracker.registered.pipe(
          Effect.map(IssueTrackerRegistry.fromTrackers),
          Effect.provide(
            Layer.merge(
              Layer.mock(JiraApi.JiraApi)({}),
              Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(jira)),
            ),
          ),
        );
      const configured = yield* registry(config);
      expect(configured.kinds).toEqual(["jira"]);
      expect(configured.standalone[0]?.standalone).toMatchObject({
        host: SITE,
        scopeNoun: "project",
        serverManaged: true,
      });
      expect(configured.standalone[0]?.capabilities).toEqual({
        create: false,
        edit: false,
        comment: false,
        labels: false,
        assignees: false,
        reactions: false,
        templates: false,
        linkedPullRequests: false,
        events: false,
        search: true,
      });
      const unconfigured = yield* registry(undefined);
      expect([unconfigured.kinds, unconfigured.get(JiraIssueTracker.KIND)]).toEqual([[], null]);
    }),
  );

  it("maps a raw issue to a neutral row, open or closed by status category", () => {
    expect(JiraIssueTracker.toTrackerIssueSummary(rawIssue, SITE)).toEqual({
      key: "ABC-12",
      displayKey: "ABC-12",
      title: "Fix the login",
      url: "https://acme.atlassian.net/browse/ABC-12",
      author: { login: "Grace", name: null, avatarUrl: null },
      state: { category: "open", name: "Code Review" },
      createdAt: "2026-09-30T06:00:00.000Z",
      updatedAt: "2026-10-01T10:34:56.789Z",
      // Jira keeps a resolution date on a reopened issue; an open issue has not closed.
      closedAt: null,
      assignees: [{ login: "Ada", name: null, avatarUrl: "https://a/48" }],
      labels: [{ name: "backend", color: null }],
      commentCount: 0,
    });
    const bare = JiraIssueTracker.toTrackerIssueSummary(
      { id: "1", key: "ABC-1", fields: { status: { statusCategory: { key: "done" } } } },
      SITE,
    );
    expect(bare).toMatchObject({
      title: "ABC-1",
      author: null,
      state: { category: "closed", name: "Done" },
      closedAt: null,
    });
    expect([
      JiraIssueTracker.toIssueState("Backlog", "todo"),
      JiraIssueTracker.toIssueState("Won't Do", "done"),
    ]).toEqual([
      { category: "open", name: "Backlog" },
      { category: "closed", name: "Won't Do" },
    ]);
  });

  it.effect("parses issue URLs on the reader's site only", () =>
    withTracker({}, (tracker) =>
      Effect.sync(() => {
        const parse = (url: string) => tracker.parseIssueUrl(new URL(url));
        expect(parse("https://acme.atlassian.net/browse/ABC-12?focusedCommentId=7")).toEqual({
          host: SITE,
          workspace: SITE,
          scope: "ABC",
          key: "ABC-12",
        });
        expect(parse("https://ACME.atlassian.net/browse/my_proj-3/")).toMatchObject({
          scope: "MY_PROJ",
          key: "MY_PROJ-3",
        });
        for (const url of [
          "https://beta.atlassian.net/browse/ABC-12",
          "http://acme.atlassian.net/browse/ABC-12",
          "https://acme.atlassian.net.evil.test/browse/ABC-12",
          "https://acme.atlassian.net/browse/ABC-12/extra",
          "https://acme.atlassian.net/browse/ABC-0",
          "https://acme.atlassian.net/jira/software/projects/ABC/boards/1",
        ]) {
          expect(parse(url)).toBeNull();
        }
      }),
    ),
  );

  it.effect("lists a project with the reader identity and hands Jira's page token back", () => {
    const searches: Array<unknown> = [];
    return withTracker(
      {
        searchJql: (identity, input) =>
          Effect.sync(() => {
            searches.push({ as: identity.name, ...input });
            return { issues: [rawIssue], nextPageToken: "next-1" };
          }),
      },
      (tracker) =>
        Effect.gen(function* () {
          const page = yield* tracker.listIssues({
            ...target,
            involvement: "all",
            state: "open",
            limit: 25,
            sort: "updated",
            query: 'x" OR project = "SECRET',
            cursor: "page-0",
          });
          expect(page.items.map((item) => item.key)).toEqual(["ABC-12"]);
          expect(page.nextCursor).toBe("next-1");
          expect(searches).toEqual([
            {
              as: "bot",
              jql: 'project = "ABC" AND statusCategory != Done AND text ~ "x OR project = SECRET" ORDER BY updated DESC',
              fields: expect.arrayContaining(["summary", "status", "created", "reporter"]),
              maxResults: 25,
              nextPageToken: "page-0",
            },
          ]);
        }),
    );
  });

  it.effect("reads an issue with its newest comments oldest first, then pages older ones", () => {
    const total = 120;
    const reads: Array<number | undefined> = [];
    return withTracker(
      {
        getIssue: () => Effect.succeed(rawIssue),
        // Newest first, as Jira answers `orderBy=-created`.
        getComments: (_identity, _key, options) =>
          Effect.sync(() => {
            reads.push(options.startAt);
            const startAt = options.startAt ?? 0;
            const ids = Array.from({ length: total }, (_, index) => total - index);
            return {
              comments: ids.slice(startAt, startAt + options.maxResults).map(rawComment),
              total,
            };
          }),
      },
      (tracker) =>
        Effect.gen(function* () {
          const detail = yield* tracker.getIssue({ ...target, key: "abc-12" });
          expect(detail).toMatchObject({
            body: "Steps",
            commentCount: total,
            states: [],
            viewer: null,
            commentsCursor: "50",
            events: [],
            linkedPullRequests: [],
          });
          expect(detail.comments.map((comment) => comment.id)).toEqual(
            Array.from({ length: 50 }, (_, index) => String(71 + index)),
          );
          expect(detail.comments.at(-1)).toMatchObject({
            author: { login: "Ada" },
            body: "c120",
            url: "https://acme.atlassian.net/browse/ABC-12?focusedCommentId=120",
          });
          const older = yield* tracker.getComments({ ...target, key: "ABC-12", cursor: "50" });
          expect([older.comments[0]?.id, older.comments.at(-1)?.id, older.nextCursor]).toEqual([
            "21",
            "70",
            "100",
          ]);
          const oldest = yield* tracker.getComments({ ...target, key: "ABC-12", cursor: "100" });
          expect([oldest.comments.length, oldest.nextCursor]).toEqual([20, null]);
          expect(reads).toEqual([undefined, 50, 100]);
          expect(
            yield* Effect.flip(tracker.getComments({ ...target, key: "ABC-12", cursor: "1e3" })),
          ).toMatchObject({ reason: "failed" });
        }),
    );
  });

  it.effect("names an issue for a link, and refuses a key Jira would not recognise", () =>
    withTracker(
      {
        getIssue: (_identity, key) =>
          key === "ABC-12"
            ? Effect.succeed(rawIssue)
            : Effect.fail(new JiraError({ reason: "not-found", message: "No such issue." })),
      },
      (tracker) =>
        Effect.gen(function* () {
          expect(yield* tracker.getIssueLink!({ ...target, key: "ABC-12" })).toEqual({
            title: "Fix the login",
            url: "https://acme.atlassian.net/browse/ABC-12",
            displayKey: "ABC-12",
          });
          expect(
            yield* Effect.flip(tracker.getIssueLink!({ ...target, key: "ABC-99" })),
          ).toMatchObject({ tracker: "jira", reason: "not-found", detail: "No such issue." });
          expect(
            yield* Effect.flip(tracker.getIssue({ ...target, key: "../myself" })),
          ).toMatchObject({ reason: "not-found" });
        }),
    ),
  );

  it.effect("probes as the reader: its name, its site, and every project page as scopes", () => {
    const pages: Array<number> = [];
    return withTracker(
      {
        myself: () => Effect.succeed({ accountId: "acc-9", displayName: "T3 Bot" }),
        searchProjects: (_identity, input) =>
          Effect.sync(() => {
            pages.push(input.startAt);
            return input.startAt === 0
              ? { projects: [{ key: "ABC", name: "Alphabet" }], isLast: false }
              : { projects: [{ key: "OPS" }], isLast: true };
          }),
      },
      (tracker) =>
        Effect.gen(function* () {
          expect(yield* tracker.probeCredential("ignored")).toEqual({
            account: "T3 Bot",
            workspace: SITE,
            scopes: [
              { key: "ABC", name: "Alphabet" },
              { key: "OPS", name: "OPS" },
            ],
          });
          expect(pages).toEqual([0, 100]);
          expect(yield* tracker.getViewer({ cwd: "/repo", host: SITE })).toBe("T3 Bot");
        }),
    );
  });

  it.effect("reports a refused reader identity as unauthenticated", () =>
    withTracker(
      {
        myself: () => Effect.fail(new JiraError({ reason: "unauthorized", message: "Refused." })),
        searchProjects: () => Effect.succeed({ projects: [], isLast: true }),
      },
      (tracker) =>
        Effect.gen(function* () {
          expect(yield* Effect.flip(tracker.probeCredential(""))).toMatchObject({
            reason: "unauthenticated",
            detail: "Refused.",
          });
        }),
    ),
  );
});
