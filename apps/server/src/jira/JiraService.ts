import {
  JIRA_ISSUE_KEY_PATTERN,
  JiraError,
  type AuthUserId,
  type JiraCapabilities,
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
  type JiraSearchInput,
  type JiraSearchResult,
  type JiraSprint,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
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
  toTransition,
  type JiraFieldIds,
} from "./issueMapping.ts";
import { listJiraIssueLinkedThreads, listJiraIssuePullRequests } from "./localLinks.ts";

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
const FILTER_SEARCH_LIMIT = 50;
const DETAIL_FIELDS = ["description", "reporter", "created"];
/** Issues read to find a project's open sprints; scoped tokens cannot list sprints directly. */
const SPRINT_SEARCH_LIMIT = 100;

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
    /** The site's sprint and story point field ids as `identity` sees them. */
    readonly fieldIds: (identity: JiraServerIdentity) => Effect.Effect<JiraFieldIds, JiraError>;
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

  const createMeta: JiraService["Service"]["createMeta"] = Effect.fn("JiraService.createMeta")(
    function* (input, options) {
      yield* annotateActingUser(options);
      const identity = yield* readIdentity(input.site, options);
      return yield* cache
        .get(
          "createMeta",
          cacheKey(identity, input.projectKey),
          Effect.gen(function* () {
            const ids = yield* fieldIds(identity);
            const [issueTypes, sprints] = yield* Effect.all(
              [
                api.createMetaIssueTypes(identity, input.projectKey),
                ids.sprint === null
                  ? Effect.succeed([])
                  : api
                      .searchJql(identity, {
                        jql: `project = "${input.projectKey}" AND (sprint in openSprints() OR sprint in futureSprints())`,
                        fields: [ids.sprint],
                        maxResults: SPRINT_SEARCH_LIMIT,
                      })
                      .pipe(
                        Effect.map((page) =>
                          (page.issues ?? []).flatMap(
                            (issue) =>
                              toIssueSummary(issue, { site: identity.site, fieldIds: ids }).sprints,
                          ),
                        ),
                      ),
              ],
              { concurrency: "unbounded" },
            );
            const openSprints = new Map<number, JiraSprint>();
            for (const sprint of sprints) {
              if (sprint.state !== "closed") openSprints.set(sprint.id, sprint);
            }
            return {
              issueTypes: issueTypes.map((type) => ({
                id: type.id,
                name: type.untranslatedName ?? type.name,
                subtask: type.subtask ?? false,
              })),
              sprints: [...openSprints.values()],
            };
          }),
        )
        .pipe(asIdentity(identity));
    },
  );

  return JiraService.of({
    capabilities,
    filters,
    filter,
    search,
    issue,
    issuesByKeys,
    linkedThreads,
    pullRequestsForIssue,
    createMeta,
    fieldIds,
  });
});

export const layer = Layer.effect(JiraService, make);
