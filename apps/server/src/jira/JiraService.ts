import {
  JIRA_ISSUE_KEY_PATTERN,
  JiraError,
  type AuthUserId,
  type JiraAddCommentInput,
  type JiraCapabilities,
  type JiraComment,
  type JiraCreateMeta,
  type JiraCreateMetaInput,
  type JiraFilterInput,
  type JiraFiltersInput,
  type JiraFiltersResult,
  type JiraFilterView,
  type JiraIssueDetail,
  type JiraIssueInput,
  type JiraIssueKey,
  type JiraIssueSummary,
  type JiraLinkedPullRequest,
  type JiraLinkedThread,
  type JiraProjectSprint,
  type JiraSearchInput,
  type JiraSearchResult,
  type JiraSetSprintInput,
  type JiraSetSprintResult,
  type JiraSetStoryPointsInput,
  type JiraSprintsInput,
  type JiraSprintsResult,
  type JiraTransitionIssueInput,
  type JiraVelocityInput,
  type JiraVelocityResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import type { JiraServerIdentity } from "./JiraConfig.ts";
import * as JiraApi from "./JiraApi.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import * as JiraReadCache from "./JiraReadCache.ts";
import * as JiraUserCredentials from "./JiraUserCredentials.ts";
import {
  resolveFieldIds,
  summaryFields,
  toComment,
  toDescription,
  toFilterView,
  toIsoDateTime,
  toIssueSummary,
  toJiraUser,
  toProjectSprints,
  toStoryPoints,
  toTransition,
  type JiraFieldIds,
} from "./issueMapping.ts";
import { listJiraIssueLinkedThreads, listJiraIssuePullRequests } from "./localLinks.ts";
import { markdownToAdf } from "./markdownToAdf.ts";
import {
  aggregateVelocity,
  mergeProjectSprints,
  parseSprintSuggestion,
  sprintNameHasPrefix,
  sprintSuggestionPrefixes,
  type JiraVelocityRow,
} from "./sprints.ts";

/** Who a UI request is for. */
export interface JiraRequestOptions {
  /**
   * The signed-in portal user making a UI read. When they stored a personal token for the site,
   * the read goes out as them; otherwise as the configured service identity. Only the WebSocket
   * handlers pass it: background workers and agents always read as the service identities.
   */
  readonly actingUserId?: AuthUserId | undefined;
}

const DEFAULT_SEARCH_PAGE_SIZE = 100;
const BULK_FETCH_CHUNK = 100;
const COMMENT_LIMIT = 50;
/** Comments a watch reads per changed issue; more since the last read are left to jtk. */
const WATCH_COMMENT_LIMIT = 20;
const FILTER_SEARCH_LIMIT = 50;
/**
 * How long, and how many, comments T3 Code posted are remembered so a watch does not count them.
 * A watch reads a changed issue within minutes, so a few hours covers a slow or paused sweep.
 */
const POSTED_COMMENT_TTL = Duration.hours(4);
const POSTED_COMMENT_CAPACITY = 2000;
const DETAIL_FIELDS = ["description", "reporter", "created"];
/** Issues read to find a project's open sprints; scoped tokens cannot list sprints directly. */
const SPRINT_SEARCH_LIMIT = 100;
/** Reads one sprint lookup makes at most, each leaving out the issues already accounted for. */
const SPRINT_SEARCH_ROUNDS = 5;
/** Autocomplete requests per sprints read, each for one name prefix. */
const SPRINT_SUGGESTION_PREFIXES = 3;
const VELOCITY_PAGE_SIZE = 100;
/** Issues a velocity read pages through, newest created first, before calling it partial. */
const VELOCITY_ISSUE_LIMIT = 500;
const DEFAULT_VELOCITY_SPRINTS = 6;
const SET_SPRINT_CONCURRENCY = 4;

const signInRequired = new JiraError({
  reason: "forbidden",
  message: "Sign in to T3 Code with your organisation account to comment or move Jira issues.",
});

const personalTokenRequired = new JiraError({
  reason: "personal-token-required",
  message: "Add your Jira token in Settings → Account to comment or move issues as yourself.",
});

export class JiraService extends Context.Service<
  JiraService,
  {
    /** Never fails: a reader Jira refuses is reported as `readerError`. */
    readonly capabilities: (options?: JiraRequestOptions) => Effect.Effect<JiraCapabilities>;
    /** With a query, filters whose name matches; without, the reader's favourites and own filters. */
    readonly filters: (
      input: JiraFiltersInput,
      options?: JiraRequestOptions,
    ) => Effect.Effect<JiraFiltersResult, JiraError>;
    readonly filter: (
      input: JiraFilterInput,
      options?: JiraRequestOptions,
    ) => Effect.Effect<JiraFilterView, JiraError>;
    /** One page of a saved filter's issues, or of ad-hoc JQL. `refresh` re-reads the filter too. */
    readonly search: (
      input: JiraSearchInput,
      options?: JiraRequestOptions,
    ) => Effect.Effect<JiraSearchResult, JiraError>;
    /** The issue with comments and transitions, joined with the threads and pull requests T3 links to it. */
    readonly issue: (
      input: JiraIssueInput,
      options?: JiraRequestOptions,
    ) => Effect.Effect<JiraIssueDetail, JiraError>;
    /**
     * Rows for many keys on one site; issues the identity cannot see are absent. They feed state
     * every user shares, so this always reads as the service identity.
     */
    readonly issuesByKeys: (
      site: string,
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<JiraIssueSummary>, JiraError>;
    /**
     * What a watch reads once an issue's `updated` moved: its newest comments, newest first; the
     * accounts every configured service identity comments as, agents' included; and which of
     * the comments T3 Code posted itself. Neither kind ever wakes an agent. Always the service
     * identity and never cached, like `issuesByKeys`.
     */
    readonly watchComments: (
      site: string,
      key: string,
    ) => Effect.Effect<
      {
        readonly comments: ReadonlyArray<JiraComment>;
        readonly ownAccountIds: ReadonlySet<string>;
        readonly ownCommentIds: ReadonlySet<string>;
      },
      JiraError
    >;
    /**
     * Remembers a comment T3 Code posted outside `addComment`, such as an approved proposal's,
     * so a watch on the issue does not wake its agent for it.
     */
    readonly recordPostedComment: (
      site: string,
      key: string,
      commentId: string,
    ) => Effect.Effect<void>;
    readonly linkedThreads: (
      input: JiraIssueKey,
    ) => Effect.Effect<ReadonlyArray<JiraLinkedThread>, JiraError>;
    readonly pullRequestsForIssue: (
      input: JiraIssueKey,
    ) => Effect.Effect<ReadonlyArray<JiraLinkedPullRequest>, JiraError>;
    /**
     * What a proposal card offers when editing a draft in one project: the issue types the
     * caller may create, and the active and future sprints found on the project's issues.
     */
    readonly createMeta: (
      input: JiraCreateMetaInput,
      options?: JiraRequestOptions,
    ) => Effect.Effect<JiraCreateMeta, JiraError>;
    /**
     * The project's active and future sprints as the caller sees them, empty ones included when
     * Jira's JQL autocomplete finds them by name.
     */
    readonly sprints: (
      input: JiraSprintsInput,
      options?: JiraRequestOptions,
    ) => Effect.Effect<JiraSprintsResult, JiraError>;
    /**
     * Committed and completed points of the project's recent closed sprints, from the issues the
     * caller can see. The sprint report is Agile API only, so this sums the issues' sprint fields.
     */
    readonly velocity: (
      input: JiraVelocityInput,
      options?: JiraRequestOptions,
    ) => Effect.Effect<JiraVelocityResult, JiraError>;
    /** The site's sprint and story point field ids as `identity` sees them. */
    readonly fieldIds: (identity: JiraServerIdentity) => Effect.Effect<JiraFieldIds, JiraError>;
    /**
     * Posts a comment as the caller's personal token for the issue's site, never a service
     * identity. Their next issue read asks Jira again.
     */
    readonly addComment: (
      userId: AuthUserId | undefined,
      input: JiraAddCommentInput,
    ) => Effect.Effect<JiraComment, JiraError>;
    /**
     * Takes a transition as the caller's personal token, if the issue still offers it to them.
     * Their next issue read asks Jira again.
     */
    readonly transitionIssue: (
      userId: AuthUserId | undefined,
      input: JiraTransitionIssueInput,
    ) => Effect.Effect<void, JiraError>;
    /**
     * Moves issues into a sprint, or back to the backlog, as the caller's personal token. Each
     * issue is written on its own and a refusal is reported per issue; a rejected token fails
     * the call. Rank is left alone, and Jira decides which sprints take issues.
     */
    readonly setSprint: (
      userId: AuthUserId | undefined,
      input: JiraSetSprintInput,
    ) => Effect.Effect<JiraSetSprintResult, JiraError>;
    /** Sets or clears an issue's story points as the caller's personal token. */
    readonly setStoryPoints: (
      userId: AuthUserId | undefined,
      input: JiraSetStoryPointsInput,
    ) => Effect.Effect<void, JiraError>;
  }
>()("t3/jira/JiraService") {}

const annotateActingUser = (options: JiraRequestOptions | undefined) =>
  options?.actingUserId === undefined
    ? Effect.void
    : Effect.annotateCurrentSpan("jira.actingUserId", options.actingUserId);

const chunk = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );

const make = Effect.gen(function* () {
  const identities = yield* JiraIdentities.JiraIdentities;
  const api = yield* JiraApi.JiraApi;
  const cache = yield* JiraReadCache.JiraReadCache;
  const credentials = yield* JiraUserCredentials.JiraUserCredentials;
  const sql = yield* SqlClient.SqlClient;

  /**
   * The identity a UI read of `site` (the reader's when absent) runs as: the acting user's
   * personal token when they stored one for that site, else the service identity.
   */
  const readIdentity = (site: string | undefined, options: JiraRequestOptions | undefined) =>
    Effect.gen(function* () {
      const service = yield* site === undefined ? identities.reader : identities.forSite(site);
      if (options?.actingUserId === undefined) return service;
      const personal = yield* credentials.identityFor(options.actingUserId, service.site);
      return personal ?? service;
    });

  /**
   * A personal token Jira rejects is recorded and reported; the read never falls back to the
   * service identity, which would show the user what their own account cannot see.
   */
  const asIdentity =
    (identity: JiraServerIdentity) =>
    <A>(effect: Effect.Effect<A, JiraError>): Effect.Effect<A, JiraError> =>
      identity.personal === undefined
        ? effect
        : effect.pipe(
            Effect.catchTags({
              JiraError: (error) =>
                error.reason !== "unauthorized"
                  ? Effect.fail(error)
                  : credentials.recordRejected(identity, error.message).pipe(
                      Effect.ignore,
                      Effect.andThen(
                        Effect.fail(
                          new JiraError({
                            reason: "unauthorized",
                            message:
                              "Jira rejected your personal Jira token. Update or remove it in Settings → Account.",
                          }),
                        ),
                      ),
                    ),
            }),
          );

  const cacheKey = (identity: JiraServerIdentity, ...parts: ReadonlyArray<unknown>) =>
    JSON.stringify([identity.name, ...parts]);

  const fieldIds = (identity: JiraServerIdentity): Effect.Effect<JiraFieldIds, JiraError> =>
    cache.get(
      "fields",
      cacheKey(identity),
      api.getFields(identity).pipe(Effect.map(resolveFieldIds)),
    );

  const myself = (identity: JiraServerIdentity) =>
    cache.get("myself", cacheKey(identity), api.myself(identity));

  // In insertion order, which with one TTL is also expiry order.
  const postedComments = new Map<string, number>();
  const postedCommentId = (site: string, key: string, commentId: string) =>
    `${site.toLowerCase()}\u0000${key.toUpperCase()}\u0000${commentId}`;

  const recordPostedComment: JiraService["Service"]["recordPostedComment"] = (
    site,
    key,
    commentId,
  ) =>
    Effect.map(Clock.currentTimeMillis, (nowMs) => {
      for (const [id, expiresAtMs] of postedComments) {
        if (expiresAtMs > nowMs && postedComments.size < POSTED_COMMENT_CAPACITY) break;
        postedComments.delete(id);
      }
      const id = postedCommentId(site, key, commentId);
      postedComments.delete(id);
      postedComments.set(id, nowMs + Duration.toMillis(POSTED_COMMENT_TTL));
    });

  /**
   * The accounts the service identities comment as. One that Jira refuses is left out, so its
   * comments may wake an agent, unless it is the identity the watch reads as, whose read fails.
   */
  const serviceAccountIds = (reading: JiraServerIdentity) =>
    Effect.forEach(
      identities.services,
      (service) => {
        const accountId = myself(service).pipe(
          Effect.map((user) => toJiraUser(user)?.accountId ?? null),
        );
        return service.name === reading.name
          ? accountId
          : accountId.pipe(
              Effect.catchTags({
                JiraError: (error) =>
                  Effect.logWarning("Could not read a Jira identity's account for watches", {
                    identity: service.name,
                    reason: error.reason,
                  }).pipe(Effect.as(null)),
              }),
            );
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(
        (accountIds) =>
          new Set(accountIds.filter((accountId): accountId is string => accountId !== null)),
      ),
    );

  const filterById = (identity: JiraServerIdentity, id: string, refresh?: boolean) =>
    cache.get(
      "filter",
      cacheKey(identity, id),
      api.getFilter(identity, id).pipe(Effect.map((filter) => toFilterView(filter, identity.site))),
      { refresh },
    );

  const searchPage = (
    identity: JiraServerIdentity,
    request: { readonly jql: string; readonly maxResults: number; readonly nextPageToken?: string },
    refresh: boolean | undefined,
  ) =>
    cache.get(
      "search",
      cacheKey(identity, request.jql, request.maxResults, request.nextPageToken ?? null),
      Effect.gen(function* () {
        const ids = yield* fieldIds(identity);
        const page = yield* api.searchJql(identity, { ...request, fields: summaryFields(ids) });
        return {
          issues: (page.issues ?? []).map((issue) =>
            toIssueSummary(issue, { site: identity.site, fieldIds: ids }),
          ),
          nextPageToken: page.nextPageToken ?? null,
        };
      }),
      { refresh },
    );

  const capabilities: JiraService["Service"]["capabilities"] = Effect.fn(
    "JiraService.capabilities",
  )(function* (options) {
    yield* annotateActingUser(options);
    if (!identities.configured) {
      return {
        configured: false,
        identities: [],
        reader: null,
        viewer: null,
        readerError: null,
        personalTokens: false,
        personalCredential: null,
      };
    }
    const reader = identities.list.find((identity) => identity.reader) ?? null;
    const viewer = yield* identities.reader.pipe(
      Effect.flatMap(myself),
      Effect.map((user) => ({ viewer: toJiraUser(user), readerError: null })),
      Effect.catchTags({
        JiraError: (error) => Effect.succeed({ viewer: null, readerError: error.message }),
      }),
    );
    const userId = options?.actingUserId;
    const personalCredential =
      userId === undefined
        ? null
        : yield* credentials.get(userId).pipe(
            Effect.catchTags({
              JiraError: (error) =>
                Effect.logWarning("could not read a personal Jira token", {
                  message: error.message,
                }).pipe(Effect.as(null)),
            }),
          );
    return {
      configured: true,
      identities: identities.list,
      reader,
      ...viewer,
      personalTokens: userId !== undefined,
      personalCredential,
    };
  });

  const filters: JiraService["Service"]["filters"] = Effect.fn("JiraService.filters")(
    function* (input, options) {
      yield* annotateActingUser(options);
      const reader = yield* readIdentity(undefined, options);
      const found = yield* cache
        .get(
          "filters",
          cacheKey(reader, input.query ?? null),
          Effect.gen(function* () {
            if (input.query !== undefined) {
              return yield* api.searchFilters(reader, {
                filterName: input.query,
                maxResults: FILTER_SEARCH_LIMIT,
              });
            }
            const accountId = toJiraUser(yield* myself(reader))?.accountId;
            const [favourites, own] = yield* Effect.all(
              [
                api.favouriteFilters(reader),
                accountId === undefined
                  ? Effect.succeed([])
                  : api.searchFilters(reader, { accountId, maxResults: FILTER_SEARCH_LIMIT }),
              ],
              { concurrency: "unbounded" },
            );
            return [...favourites, ...own];
          }).pipe(
            Effect.map((raw) =>
              [...new Map(raw.map((filter) => [filter.id, filter])).values()].map((filter) =>
                toFilterView(filter, reader.site),
              ),
            ),
          ),
        )
        .pipe(asIdentity(reader));
      return { filters: found };
    },
  );

  const filter: JiraService["Service"]["filter"] = Effect.fn("JiraService.filter")(
    function* (input, options) {
      yield* annotateActingUser(options);
      const identity = yield* readIdentity(undefined, options);
      return yield* filterById(identity, input.id).pipe(asIdentity(identity));
    },
  );

  const search: JiraService["Service"]["search"] = Effect.fn("JiraService.search")(
    function* (input, options) {
      yield* annotateActingUser(options);
      if ((input.filterId === undefined) === (input.jql === undefined)) {
        return yield* new JiraError({
          reason: "invalid",
          message: "Search needs exactly one of a filter id or JQL.",
        });
      }
      const reader = yield* readIdentity(undefined, options);
      const savedFilter =
        input.filterId === undefined
          ? null
          : yield* filterById(reader, input.filterId, input.refresh).pipe(asIdentity(reader));
      const jql = savedFilter?.jql ?? input.jql ?? "";
      if (jql.trim().length === 0) {
        return yield* new JiraError({ reason: "invalid", message: "The filter has no JQL." });
      }
      const page = yield* searchPage(
        reader,
        {
          jql,
          maxResults: input.maxResults ?? DEFAULT_SEARCH_PAGE_SIZE,
          ...(input.nextPageToken === undefined ? {} : { nextPageToken: input.nextPageToken }),
        },
        input.refresh,
      ).pipe(asIdentity(reader));
      return { ...page, filter: savedFilter };
    },
  );

  const linkedThreads: JiraService["Service"]["linkedThreads"] = (input) =>
    listJiraIssueLinkedThreads(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const pullRequestsForIssue: JiraService["Service"]["pullRequestsForIssue"] = (input) =>
    listJiraIssuePullRequests(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const issue: JiraService["Service"]["issue"] = Effect.fn("JiraService.issue")(
    function* (input, options) {
      yield* annotateActingUser(options);
      const identity = yield* readIdentity(input.site, options);
      // Jira's part is cached as one entry, converted once; local links are always fresh.
      const remote = yield* cache
        .get(
          "issue",
          cacheKey(identity, input.key),
          Effect.gen(function* () {
            const ids = yield* fieldIds(identity);
            const [raw, comments, transitions] = yield* Effect.all(
              [
                api.getIssue(identity, input.key, {
                  fields: [...summaryFields(ids), ...DETAIL_FIELDS],
                }),
                api.getComments(identity, input.key, {
                  maxResults: COMMENT_LIMIT,
                  orderBy: "-created",
                }),
                api.getTransitions(identity, input.key),
              ],
              { concurrency: "unbounded" },
            );
            const fields = raw.fields ?? {};
            const latest = (comments.comments ?? []).flatMap((comment) => {
              const mapped = toComment(comment);
              return mapped === null ? [] : [mapped];
            });
            return {
              ...toIssueSummary(raw, { site: identity.site, fieldIds: ids }),
              reporter: toJiraUser(fields.reporter),
              created: toIsoDateTime(fields.created),
              description: toDescription(raw),
              // Fetched newest first so the cap keeps the latest; shown oldest first.
              comments: latest.toReversed(),
              commentCount: Math.max(comments.total ?? latest.length, latest.length),
              transitions: transitions.map(toTransition),
            };
          }),
          { refresh: input.refresh },
        )
        .pipe(asIdentity(identity));
      const key = { site: identity.site, key: input.key };
      const [threads, pullRequests] = yield* Effect.all(
        [linkedThreads(key), pullRequestsForIssue(key)],
        { concurrency: "unbounded" },
      );
      return { ...remote, linkedThreads: threads, pullRequests };
    },
  );

  const issuesByKeys: JiraService["Service"]["issuesByKeys"] = Effect.fn(
    "JiraService.issuesByKeys",
  )(function* (site, keys) {
    const valid = [...new Set(keys.filter((key) => JIRA_ISSUE_KEY_PATTERN.test(key)))].toSorted();
    if (valid.length === 0) return [];
    const identity = yield* identities.forSite(site);
    const ids = yield* fieldIds(identity);
    const chunks = yield* Effect.forEach(
      chunk(valid, BULK_FETCH_CHUNK),
      (batch) =>
        cache.get(
          "search",
          cacheKey(identity, "keys", batch),
          api
            .bulkFetch(identity, { keys: batch, fields: summaryFields(ids) })
            .pipe(
              Effect.map((issues) =>
                issues.map((issue) =>
                  toIssueSummary(issue, { site: identity.site, fieldIds: ids }),
                ),
              ),
            ),
        ),
      { concurrency: 4 },
    );
    return chunks.flat();
  });

  const watchComments: JiraService["Service"]["watchComments"] = Effect.fn(
    "JiraService.watchComments",
  )(function* (site, key) {
    const identity = yield* identities.forSite(site);
    const [raw, ownAccountIds] = yield* Effect.all(
      [
        api.getComments(identity, key, { maxResults: WATCH_COMMENT_LIMIT, orderBy: "-created" }),
        serviceAccountIds(identity),
      ],
      { concurrency: "unbounded" },
    );
    const comments = (raw.comments ?? []).flatMap((comment) => {
      const mapped = toComment(comment);
      return mapped === null ? [] : [mapped];
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const ownCommentIds = new Set(
      comments
        .filter(
          (comment) =>
            (postedComments.get(postedCommentId(identity.site, key, comment.id)) ?? 0) > nowMs,
        )
        .map((comment) => comment.id),
    );
    return { comments, ownAccountIds, ownCommentIds };
  });

  /**
   * Every sprint the sprint field lists on the issues `jqlFor` finds, closed ones included. A
   * read that comes back full asks again with the JQL `jqlFor` builds from what was found, which
   * leaves out the issues already accounted for, so each round finds new sprints or stops.
   * `jqlFor` returns null when nothing is left to look for.
   */
  const sprintsOnIssues = Effect.fn("JiraService.sprintsOnIssues")(function* (
    identity: JiraServerIdentity,
    sprintField: string,
    jqlFor: (found: ReadonlyArray<JiraProjectSprint>) => string | null,
  ) {
    const found = new Map<number, JiraProjectSprint>();
    for (let round = 0; round < SPRINT_SEARCH_ROUNDS; round++) {
      const jql = jqlFor([...found.values()]);
      if (jql === null) break;
      const page = yield* api.searchJql(identity, {
        jql,
        fields: [sprintField],
        maxResults: SPRINT_SEARCH_LIMIT,
      });
      const issues = page.issues ?? [];
      const before = found.size;
      for (const issue of issues) {
        for (const sprint of toProjectSprints(issue.fields?.[sprintField])) {
          if (!found.has(sprint.id)) found.set(sprint.id, sprint);
        }
      }
      if (issues.length < SPRINT_SEARCH_LIMIT || found.size === before) break;
    }
    return [...found.values()];
  });

  /**
   * Autocomplete only makes the list more complete, so a failure other than a rejected token
   * falls back to the sprints the project's issues name.
   */
  const autocompleteOr =
    <B>(fallback: B) =>
    <A>(effect: Effect.Effect<A, JiraError>): Effect.Effect<A | B, JiraError> =>
      effect.pipe(
        Effect.catchTags({
          JiraError: (error) =>
            error.reason === "unauthorized"
              ? Effect.fail(error)
              : Effect.logWarning("Could not complete a Jira project's sprints from autocomplete", {
                  reason: error.reason,
                }).pipe(Effect.as(fallback)),
        }),
      );

  const suggestedSprints = (identity: JiraServerIdentity, prefix: string) =>
    api.sprintSuggestions(identity, prefix).pipe(
      Effect.map((suggestions) =>
        suggestions.flatMap((suggestion) => {
          const sprint = parseSprintSuggestion(suggestion);
          return sprint !== null && sprintNameHasPrefix(sprint.name, prefix) ? [sprint] : [];
        }),
      ),
      autocompleteOr([]),
    );

  const readProjectSprints = Effect.fn("JiraService.readProjectSprints")(function* (
    identity: JiraServerIdentity,
    projectKey: string,
  ) {
    const sprintField = (yield* fieldIds(identity)).sprint;
    if (sprintField === null) return [];
    const openJql = `project = "${projectKey}" AND (sprint in openSprints() OR sprint in futureSprints())`;
    const [fromIssues, byProjectKey] = yield* Effect.all(
      [
        // An issue is in one open sprint at most, so leaving out the open sprints already found
        // leaves only issues in ones not found yet. Closed sprints stay in: carried-over issues
        // list them beside their open one.
        sprintsOnIssues(identity, sprintField, (found) => {
          const open = found.filter((sprint) => sprint.state !== "closed");
          return open.length === 0
            ? openJql
            : `${openJql} AND sprint not in (${open.map((sprint) => sprint.id).join(", ")})`;
        }),
        suggestedSprints(identity, projectKey),
      ],
      { concurrency: "unbounded" },
    );
    const prefixes = sprintSuggestionPrefixes(
      projectKey,
      mergeProjectSprints(fromIssues, []),
      SPRINT_SUGGESTION_PREFIXES,
    ).filter((prefix) => prefix !== projectKey);
    const byName = yield* Effect.forEach(prefixes, (prefix) => suggestedSprints(identity, prefix), {
      concurrency: "unbounded",
    });
    const suggested = [...byProjectKey, ...byName.flat()];
    const known = new Set(fromIssues.map((sprint) => sprint.id));
    const unknownIds = [
      ...new Set(suggested.map((sprint) => sprint.id).filter((id) => !known.has(id))),
    ];
    if (unknownIds.length === 0) return mergeProjectSprints(fromIssues, suggested);
    // Autocomplete lists closed sprints and other teams' sprints too, and says neither. A
    // sprint any issue is in is one of those: an open sprint this project uses was already
    // found on its issues. Only empty sprints are kept, and without the answer none are.
    return yield* sprintsOnIssues(identity, sprintField, (found) => {
      const seen = new Set(found.map((sprint) => sprint.id));
      const remaining = unknownIds.filter((id) => !seen.has(id));
      return remaining.length === 0 ? null : `sprint in (${remaining.join(", ")})`;
    }).pipe(
      Effect.map((revealed) => {
        const used = new Set(revealed.map((sprint) => sprint.id));
        return mergeProjectSprints(
          fromIssues,
          suggested.filter((sprint) => !used.has(sprint.id)),
        );
      }),
      autocompleteOr(mergeProjectSprints(fromIssues, [])),
    );
  });

  const projectSprints = (
    identity: JiraServerIdentity,
    projectKey: string,
    refresh?: boolean,
  ): Effect.Effect<ReadonlyArray<JiraProjectSprint>, JiraError> =>
    cache.get("sprints", cacheKey(identity, projectKey), readProjectSprints(identity, projectKey), {
      refresh,
    });

  const sprints: JiraService["Service"]["sprints"] = Effect.fn("JiraService.sprints")(
    function* (input, options) {
      yield* annotateActingUser(options);
      const identity = yield* readIdentity(input.site, options);
      const found = yield* projectSprints(identity, input.projectKey, input.refresh).pipe(
        asIdentity(identity),
      );
      return { sprints: found };
    },
  );

  /**
   * The project's issues in closed sprints, newest first, up to the cap. Created order keeps
   * recent sprints' issues ahead of a bulk edit to old ones, so a cap cuts the oldest sprints.
   */
  const readVelocityRows = Effect.fn("JiraService.readVelocityRows")(function* (
    identity: JiraServerIdentity,
    projectKey: string,
  ) {
    const ids = yield* fieldIds(identity);
    const rows: Array<JiraVelocityRow> = [];
    if (ids.sprint === null) return { rows, partial: false };
    const sprintField = ids.sprint;
    const fields = [
      sprintField,
      ...(ids.storyPoints === null ? [] : [ids.storyPoints]),
      "resolutiondate",
    ];
    let nextPageToken: string | undefined;
    while (true) {
      const page = yield* api.searchJql(identity, {
        jql: `project = "${projectKey}" AND sprint in closedSprints() ORDER BY created DESC`,
        fields,
        maxResults: Math.min(VELOCITY_PAGE_SIZE, VELOCITY_ISSUE_LIMIT - rows.length),
        nextPageToken,
      });
      const issues = page.issues ?? [];
      for (const issue of issues) {
        const issueFields = issue.fields ?? {};
        rows.push({
          sprints: toProjectSprints(issueFields[sprintField]),
          storyPoints: toStoryPoints(issueFields, ids),
          resolutionDate: toIsoDateTime(issueFields.resolutiondate),
        });
      }
      nextPageToken = page.nextPageToken ?? undefined;
      if (nextPageToken === undefined || issues.length === 0) return { rows, partial: false };
      if (rows.length >= VELOCITY_ISSUE_LIMIT) return { rows, partial: true };
    }
  });

  const velocity: JiraService["Service"]["velocity"] = Effect.fn("JiraService.velocity")(
    function* (input, options) {
      yield* annotateActingUser(options);
      const identity = yield* readIdentity(input.site, options);
      const { rows, partial } = yield* cache
        .get(
          "velocity",
          cacheKey(identity, input.projectKey),
          readVelocityRows(identity, input.projectKey),
          { refresh: input.refresh },
        )
        .pipe(asIdentity(identity));
      return { ...aggregateVelocity(rows, input.lastN ?? DEFAULT_VELOCITY_SPRINTS), partial };
    },
  );

  const createMeta: JiraService["Service"]["createMeta"] = Effect.fn("JiraService.createMeta")(
    function* (input, options) {
      yield* annotateActingUser(options);
      const identity = yield* readIdentity(input.site, options);
      // Sprints are cached on their own, so a sprints refresh reaches the proposal card too.
      const [issueTypes, sprints] = yield* Effect.all(
        [
          cache.get(
            "createMeta",
            cacheKey(identity, input.projectKey),
            api.createMetaIssueTypes(identity, input.projectKey).pipe(
              Effect.map((types) =>
                types.map((type) => ({
                  id: type.id,
                  name: type.untranslatedName ?? type.name,
                  subtask: type.subtask ?? false,
                })),
              ),
            ),
          ),
          projectSprints(identity, input.projectKey),
        ],
        { concurrency: "unbounded" },
      ).pipe(asIdentity(identity));
      return { issueTypes, sprints };
    },
  );

  /** The caller's personal identity for `site`; a direct write never goes out as anyone else. */
  const writeIdentity = (userId: AuthUserId | undefined, site: string) =>
    Effect.gen(function* () {
      if (userId === undefined) return yield* signInRequired;
      yield* Effect.annotateCurrentSpan("jira.actingUserId", userId);
      const personal = yield* credentials.identityFor(userId, site);
      if (personal === undefined) return yield* personalTokenRequired;
      return personal;
    });

  const addComment: JiraService["Service"]["addComment"] = Effect.fn("JiraService.addComment")(
    function* (userId, input) {
      const identity = yield* writeIdentity(userId, input.site);
      const raw = yield* api
        .addComment(identity, input.key, markdownToAdf(input.body))
        .pipe(asIdentity(identity));
      yield* recordPostedComment(identity.site, input.key, raw.id);
      yield* cache.invalidate("issue", cacheKey(identity, input.key));
      // Jira answers with the whole comment; a reply missing its date still shows what was sent.
      return (
        toComment(raw) ?? {
          id: raw.id,
          author: null,
          body: input.body,
          created: DateTime.formatIso(yield* DateTime.now),
          updated: null,
        }
      );
    },
  );

  const transitionIssue: JiraService["Service"]["transitionIssue"] = Effect.fn(
    "JiraService.transitionIssue",
  )(function* (userId, input) {
    const identity = yield* writeIdentity(userId, input.site);
    yield* Effect.gen(function* () {
      const offered = yield* api.getTransitions(identity, input.key);
      if (!offered.some((transition) => transition.id === input.transitionId)) {
        // The caller saw it on an earlier read; let their next read show what is offered now.
        yield* cache.invalidate("issue", cacheKey(identity, input.key));
        return yield* new JiraError({
          reason: "invalid",
          message: `That transition is no longer available on ${input.key}.`,
        });
      }
      yield* api.transitionIssue(identity, input.key, input.transitionId);
    }).pipe(asIdentity(identity));
    yield* cache.invalidate("issue", cacheKey(identity, input.key));
  });

  /**
   * After a write as `identity`, its reads the write changed: the issues, and every search, since
   * list pages and planning sections are JQL searches. Sprints and velocity stay: moving issues
   * between open sprints or the backlog changes neither the list of sprints nor closed sprints'
   * points. Other identities' reads, such as the service reader's, are left to expire.
   */
  const invalidateWritten = (identity: JiraServerIdentity, keys: ReadonlyArray<string>) =>
    Effect.all(
      [
        Effect.forEach(keys, (key) => cache.invalidate("issue", cacheKey(identity, key)), {
          discard: true,
        }),
        cache.invalidateMatching(
          "search",
          (key) => (JSON.parse(key) as ReadonlyArray<unknown>)[0] === identity.name,
        ),
      ],
      { discard: true },
    );

  const setSprint: JiraService["Service"]["setSprint"] = Effect.fn("JiraService.setSprint")(
    function* (userId, input) {
      const identity = yield* writeIdentity(userId, input.site);
      const sprintField = (yield* fieldIds(identity).pipe(asIdentity(identity))).sprint;
      if (sprintField === null) {
        return yield* new JiraError({
          reason: "invalid",
          message: `Jira at ${identity.site} has no sprint field.`,
        });
      }
      const keys = [...new Set(input.keys)];
      // A rejected token would fail every other issue the same way, so it fails the call; the
      // writes that landed before it are still invalidated.
      const outcomes = yield* Effect.forEach(
        keys,
        (key) =>
          api.editIssue(identity, key, { [sprintField]: input.sprintId }).pipe(
            asIdentity(identity),
            Effect.as({ key, message: null }),
            Effect.catchTags({
              JiraError: (error) =>
                error.reason === "unauthorized"
                  ? Effect.fail(error)
                  : Effect.succeed({ key, message: error.message }),
            }),
          ),
        { concurrency: SET_SPRINT_CONCURRENCY },
      ).pipe(Effect.ensuring(invalidateWritten(identity, keys)));
      return {
        updated: outcomes.flatMap((outcome) => (outcome.message === null ? [outcome.key] : [])),
        failed: outcomes.flatMap(({ key, message }) =>
          message === null ? [] : [{ key, message }],
        ),
      };
    },
  );

  const setStoryPoints: JiraService["Service"]["setStoryPoints"] = Effect.fn(
    "JiraService.setStoryPoints",
  )(function* (userId, input) {
    const identity = yield* writeIdentity(userId, input.site);
    const storyPointsField = (yield* fieldIds(identity).pipe(asIdentity(identity))).storyPoints;
    if (storyPointsField === null) {
      return yield* new JiraError({
        reason: "invalid",
        message: `Jira at ${identity.site} has no story points field.`,
      });
    }
    yield* api
      .editIssue(identity, input.key, { [storyPointsField]: input.storyPoints })
      .pipe(asIdentity(identity));
    yield* invalidateWritten(identity, [input.key]);
  });

  return JiraService.of({
    capabilities,
    filters,
    filter,
    search,
    issue,
    issuesByKeys,
    watchComments,
    recordPostedComment,
    linkedThreads,
    pullRequestsForIssue,
    createMeta,
    sprints,
    velocity,
    fieldIds,
    addComment,
    transitionIssue,
    setSprint,
    setStoryPoints,
  });
});

export const layer = Layer.effect(JiraService, make);
