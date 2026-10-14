import { JiraError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import type { JiraServerIdentity } from "./JiraConfig.ts";

/**
 * Thin Jira Cloud REST v3 client. Issue writes (create, edit, comment, transition) run as a
 * user's personal token: the approver of a proposal, or the user commenting or moving an issue
 * themselves. Remote links to threads are the one write a service identity makes. Scoped tokens
 * cannot call the Agile API, the Development panel, Automation or Dashboards, so nothing here
 * does.
 */

const REQUEST_TIMEOUT = "15 seconds";
const MAX_ERROR_MESSAGE_LENGTH = 500;

// Raw response shapes. Only the parts we read are declared; Jira's extra fields are ignored.

const RawUser = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  avatarUrls: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type JiraRawUser = typeof RawUser.Type;

/** Issue fields stay untyped: which ones exist, and their ids for custom fields, vary per site. */
const RawIssue = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  fields: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type JiraRawIssue = typeof RawIssue.Type;

const RawSearchPage = Schema.Struct({
  issues: Schema.optional(Schema.Array(RawIssue)),
  nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
});
export type JiraRawSearchPage = typeof RawSearchPage.Type;

const RawBulkFetch = Schema.Struct({
  issues: Schema.optional(Schema.Array(RawIssue)),
});

const RawTransition = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  to: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      untranslatedName: Schema.optional(Schema.String),
      statusCategory: Schema.optional(Schema.Struct({ key: Schema.optional(Schema.String) })),
    }),
  ),
});
export type JiraRawTransition = typeof RawTransition.Type;

const RawTransitions = Schema.Struct({
  transitions: Schema.optional(Schema.Array(RawTransition)),
});

const RawComment = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawUser)),
  body: Schema.optional(Schema.Unknown),
  created: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
});
export type JiraRawComment = typeof RawComment.Type;

const RawComments = Schema.Struct({
  comments: Schema.optional(Schema.Array(RawComment)),
  total: Schema.optional(Schema.Number),
});
export type JiraRawComments = typeof RawComments.Type;

const RawFilter = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  jql: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.NullOr(RawUser)),
  favourite: Schema.optional(Schema.Boolean),
});
export type JiraRawFilter = typeof RawFilter.Type;

const RawFilterPage = Schema.Struct({
  values: Schema.optional(Schema.Array(RawFilter)),
});

const RawField = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  custom: Schema.optional(Schema.Boolean),
  schema: Schema.optional(
    Schema.Struct({ type: Schema.optional(Schema.String), custom: Schema.optional(Schema.String) }),
  ),
});
export type JiraRawField = typeof RawField.Type;

const RawCreatedIssue = Schema.Struct({ id: Schema.String, key: Schema.String });
export type JiraRawCreatedIssue = typeof RawCreatedIssue.Type;

const RawCreateMetaIssueType = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  untranslatedName: Schema.optional(Schema.String),
  subtask: Schema.optional(Schema.Boolean),
});
export type JiraRawCreateMetaIssueType = typeof RawCreateMetaIssueType.Type;

/** Jira documents `issueTypes`; some sites still answer with the older `values`. */
const RawCreateMetaIssueTypes = Schema.Struct({
  issueTypes: Schema.optional(Schema.Array(RawCreateMetaIssueType)),
  values: Schema.optional(Schema.Array(RawCreateMetaIssueType)),
});

const RawErrorBody = Schema.Struct({
  errorMessages: Schema.optional(Schema.Array(Schema.String)),
  errors: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const RawTenantInfo = Schema.Struct({ cloudId: Schema.String });

const decodeErrorBody = Schema.decodeUnknownOption(RawErrorBody);
const decodeRawTenantInfo = Schema.decodeUnknownEffect(RawTenantInfo);
const decodeRawUser = Schema.decodeUnknownEffect(RawUser);
const decodeRawSearchPage = Schema.decodeUnknownEffect(RawSearchPage);
const decodeRawBulkFetch = Schema.decodeUnknownEffect(RawBulkFetch);
const decodeRawIssue = Schema.decodeUnknownEffect(RawIssue);
const decodeRawTransitions = Schema.decodeUnknownEffect(RawTransitions);
const decodeRawComments = Schema.decodeUnknownEffect(RawComments);
const decodeRawFilterPage = Schema.decodeUnknownEffect(RawFilterPage);
const decodeRawFilter = Schema.decodeUnknownEffect(RawFilter);
const decodeRawFilters = Schema.decodeUnknownEffect(Schema.Array(RawFilter));
const decodeRawFields = Schema.decodeUnknownEffect(Schema.Array(RawField));
const decodeRawCreatedIssue = Schema.decodeUnknownEffect(RawCreatedIssue);
const decodeRawComment = Schema.decodeUnknownEffect(RawComment);
const decodeRawCreateMetaIssueTypes = Schema.decodeUnknownEffect(RawCreateMetaIssueTypes);

export class JiraApi extends Context.Service<
  JiraApi,
  {
    /** Unauthenticated `GET https://<site>/_edge/tenant_info`: the site's cloud id. */
    readonly tenantInfo: (site: string) => Effect.Effect<string, JiraError>;
    readonly myself: (identity: JiraServerIdentity) => Effect.Effect<JiraRawUser, JiraError>;
    /** `POST /rest/api/3/search/jql`, the enhanced search; `/search` is deprecated. */
    readonly searchJql: (
      identity: JiraServerIdentity,
      input: {
        readonly jql: string;
        readonly fields: ReadonlyArray<string>;
        readonly maxResults: number;
        readonly nextPageToken?: string | undefined;
      },
    ) => Effect.Effect<JiraRawSearchPage, JiraError>;
    /**
     * `POST /rest/api/3/issue/bulkfetch`, at most 100 keys. Issues that do not exist or that the
     * identity cannot see are left out, where a `key in (...)` JQL would reject the whole query.
     */
    readonly bulkFetch: (
      identity: JiraServerIdentity,
      input: { readonly keys: ReadonlyArray<string>; readonly fields: ReadonlyArray<string> },
    ) => Effect.Effect<ReadonlyArray<JiraRawIssue>, JiraError>;
    readonly getIssue: (
      identity: JiraServerIdentity,
      key: string,
      options: { readonly fields: ReadonlyArray<string>; readonly expand?: string | undefined },
    ) => Effect.Effect<JiraRawIssue, JiraError>;
    readonly getTransitions: (
      identity: JiraServerIdentity,
      key: string,
    ) => Effect.Effect<ReadonlyArray<JiraRawTransition>, JiraError>;
    readonly getComments: (
      identity: JiraServerIdentity,
      key: string,
      options: { readonly maxResults: number; readonly orderBy: "-created" | "created" },
    ) => Effect.Effect<JiraRawComments, JiraError>;
    /** `GET /rest/api/3/filter/search`: filters visible to the identity, by name or owner. */
    readonly searchFilters: (
      identity: JiraServerIdentity,
      input: {
        readonly filterName?: string | undefined;
        readonly accountId?: string | undefined;
        readonly maxResults: number;
      },
    ) => Effect.Effect<ReadonlyArray<JiraRawFilter>, JiraError>;
    /** `GET /rest/api/3/filter/favourite`. */
    readonly favouriteFilters: (
      identity: JiraServerIdentity,
    ) => Effect.Effect<ReadonlyArray<JiraRawFilter>, JiraError>;
    readonly getFilter: (
      identity: JiraServerIdentity,
      id: string,
    ) => Effect.Effect<JiraRawFilter, JiraError>;
    readonly getFields: (
      identity: JiraServerIdentity,
    ) => Effect.Effect<ReadonlyArray<JiraRawField>, JiraError>;
    /** `GET /rest/api/3/issue/createmeta/{projectKey}/issuetypes`: what the identity may create. */
    readonly createMetaIssueTypes: (
      identity: JiraServerIdentity,
      projectKey: string,
    ) => Effect.Effect<ReadonlyArray<JiraRawCreateMetaIssueType>, JiraError>;
    /** `POST /rest/api/3/issue`. `fields` is Jira's create body, custom field ids included. */
    readonly createIssue: (
      identity: JiraServerIdentity,
      fields: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<JiraRawCreatedIssue, JiraError>;
    /** `PUT /rest/api/3/issue/{key}`, setting `fields`, custom field ids included. */
    readonly editIssue: (
      identity: JiraServerIdentity,
      key: string,
      fields: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, JiraError>;
    /** `POST /rest/api/3/issue/{key}/comment` with an Atlassian Document Format body. */
    readonly addComment: (
      identity: JiraServerIdentity,
      key: string,
      body: unknown,
    ) => Effect.Effect<JiraRawComment, JiraError>;
    /** `POST /rest/api/3/issue/{key}/transitions`. */
    readonly transitionIssue: (
      identity: JiraServerIdentity,
      key: string,
      transitionId: string,
    ) => Effect.Effect<void, JiraError>;
    /** `POST /rest/api/3/issue/{key}/remotelink`: creates the link, or updates its `globalId`'s. */
    readonly upsertRemoteLink: (
      identity: JiraServerIdentity,
      key: string,
      link: {
        readonly globalId: string;
        readonly url: string;
        readonly title: string;
        readonly iconUrl?: string | undefined;
      },
    ) => Effect.Effect<void, JiraError>;
    /** `DELETE /rest/api/3/issue/{key}/remotelink?globalId=…`; `not-found` when already gone. */
    readonly deleteRemoteLink: (
      identity: JiraServerIdentity,
      key: string,
      globalId: string,
    ) => Effect.Effect<void, JiraError>;
  }
>()("t3/jira/JiraApi") {}

const FILTER_EXPAND = "jql,owner,favourite,viewUrl";

/**
 * Identities with a cloud id go through the API gateway, where scoped tokens work; the others go
 * to the site itself. See `JiraServerIdentity.cloudId` for which identities carry one.
 */
const baseUrl = (identity: JiraServerIdentity) =>
  identity.cloudId === undefined
    ? `https://${identity.site}`
    : `https://api.atlassian.com/ex/jira/${encodeURIComponent(identity.cloudId)}`;

/**
 * Jira translates status, issue type and priority names into the reading account's profile
 * language; these headers ask for English whatever that profile says.
 */
const englishNames = HttpClientRequest.setHeaders({
  "Accept-Language": "en",
  "X-Force-Accept-Language": "true",
});

const authorize = (identity: JiraServerIdentity) =>
  identity.authMethod === "scoped-token"
    ? HttpClientRequest.bearerToken(identity.token)
    : HttpClientRequest.basicAuth(identity.email ?? "", identity.token);

/** How error messages name the identity; a personal one is never named by its internal name. */
const describe = (identity: JiraServerIdentity) =>
  identity.personal === undefined ? `identity ${identity.name}` : "your personal Jira token";

const truncate = (text: string) =>
  text.length > MAX_ERROR_MESSAGE_LENGTH ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…` : text;

/** Jira reports rejected JQL and bad input as `errorMessages` and per-field `errors`. */
const jiraErrorText = (body: unknown) =>
  Option.match(decodeErrorBody(body), {
    onNone: () => "",
    onSome: (value) =>
      [...(value.errorMessages ?? []), ...Object.values(value.errors ?? {})]
        .map((message) => message.trim())
        .filter((message) => message.length > 0)
        .join(" "),
  });

const statusError = (
  identity: JiraServerIdentity,
  response: HttpClientResponse.HttpClientResponse,
  action: "read" | "change",
) =>
  Effect.gen(function* () {
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    const text = jiraErrorText(body);
    switch (response.status) {
      case 400:
        return new JiraError({
          reason: "invalid",
          message: truncate(text || "Jira rejected the request."),
        });
      case 401:
        return new JiraError({
          reason: "unauthorized",
          message:
            identity.personal === undefined
              ? `Jira rejected the credentials of identity ${identity.name}.`
              : "Jira rejected your personal Jira token.",
        });
      case 403:
        return new JiraError({
          reason: "forbidden",
          message: truncate(text || `Jira does not allow ${describe(identity)} to ${action} this.`),
        });
      case 404:
        return new JiraError({
          reason: "not-found",
          message: truncate(text || `Not found, or not visible to ${describe(identity)}.`),
        });
      default:
        return new JiraError({
          reason: "unavailable",
          message: `Jira at ${identity.site} answered HTTP ${response.status}.`,
        });
    }
  });

const unavailable = (site: string) => ({
  HttpClientError: () =>
    Effect.fail(
      new JiraError({ reason: "unavailable", message: `Could not reach Jira at ${site}.` }),
    ),
  SchemaError: () =>
    Effect.fail(
      new JiraError({
        reason: "unavailable",
        message: `Jira at ${site} returned an unexpected response.`,
      }),
    ),
  TimeoutError: () =>
    Effect.fail(
      new JiraError({ reason: "unavailable", message: `Jira at ${site} did not answer in time.` }),
    ),
});

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;

  /** Sends a request and fails on a non-2xx answer; `then` reads the response it accepted. */
  const send = <A>(
    identity: JiraServerIdentity,
    build: HttpClientRequest.HttpClientRequest,
    then: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, Schema.SchemaError | HttpClientError.HttpClientError>,
  ): Effect.Effect<A, JiraError> =>
    Effect.gen(function* () {
      const response = yield* http.execute(
        build.pipe(
          HttpClientRequest.prependUrl(baseUrl(identity)),
          HttpClientRequest.acceptJson,
          englishNames,
          authorize(identity),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const error = yield* statusError(
          identity,
          response,
          build.method === "GET" ? "read" : "change",
        );
        return yield* error;
      }
      return yield* then(response);
    }).pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.catchTags(unavailable(identity.site)));

  const read = <A>(
    identity: JiraServerIdentity,
    build: HttpClientRequest.HttpClientRequest,
    decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) => send(identity, build, (response) => Effect.flatMap(response.json, decode));

  const tenantInfo: JiraApi["Service"]["tenantInfo"] = (site) =>
    Effect.gen(function* () {
      const response = yield* http.execute(
        HttpClientRequest.get(`https://${site}/_edge/tenant_info`).pipe(
          HttpClientRequest.acceptJson,
          englishNames,
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new JiraError({
          reason: response.status === 404 ? "not-found" : "unavailable",
          message: `${site} did not report a Jira Cloud id (HTTP ${response.status}).`,
        });
      }
      const info = yield* decodeRawTenantInfo(yield* response.json);
      return info.cloudId;
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTags(unavailable(site)),
      Effect.withSpan("JiraApi.tenantInfo"),
    );

  return JiraApi.of({
    tenantInfo,
    myself: (identity) =>
      read(identity, HttpClientRequest.get("/rest/api/3/myself"), decodeRawUser).pipe(
        Effect.withSpan("JiraApi.myself"),
      ),
    searchJql: (identity, input) =>
      read(
        identity,
        HttpClientRequest.post("/rest/api/3/search/jql").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            jql: input.jql,
            fields: input.fields,
            maxResults: input.maxResults,
            ...(input.nextPageToken === undefined ? {} : { nextPageToken: input.nextPageToken }),
          }),
        ),
        decodeRawSearchPage,
      ).pipe(Effect.withSpan("JiraApi.searchJql")),
    bulkFetch: (identity, input) =>
      read(
        identity,
        HttpClientRequest.post("/rest/api/3/issue/bulkfetch").pipe(
          HttpClientRequest.bodyJsonUnsafe({ issueIdsOrKeys: input.keys, fields: input.fields }),
        ),
        decodeRawBulkFetch,
      ).pipe(
        Effect.map((result) => result.issues ?? []),
        Effect.withSpan("JiraApi.bulkFetch"),
      ),
    getIssue: (identity, key, options) =>
      read(
        identity,
        HttpClientRequest.get(`/rest/api/3/issue/${encodeURIComponent(key)}`).pipe(
          HttpClientRequest.setUrlParams({
            fields: options.fields.join(","),
            ...(options.expand === undefined ? {} : { expand: options.expand }),
          }),
        ),
        decodeRawIssue,
      ).pipe(Effect.withSpan("JiraApi.getIssue")),
    getTransitions: (identity, key) =>
      read(
        identity,
        HttpClientRequest.get(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`),
        decodeRawTransitions,
      ).pipe(
        Effect.map((result) => result.transitions ?? []),
        Effect.withSpan("JiraApi.getTransitions"),
      ),
    getComments: (identity, key, options) =>
      read(
        identity,
        HttpClientRequest.get(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`).pipe(
          HttpClientRequest.setUrlParams({
            maxResults: String(options.maxResults),
            orderBy: options.orderBy,
          }),
        ),
        decodeRawComments,
      ).pipe(Effect.withSpan("JiraApi.getComments")),
    searchFilters: (identity, input) =>
      read(
        identity,
        HttpClientRequest.get("/rest/api/3/filter/search").pipe(
          HttpClientRequest.setUrlParams({
            expand: FILTER_EXPAND,
            maxResults: String(input.maxResults),
            ...(input.filterName === undefined ? {} : { filterName: input.filterName }),
            ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          }),
        ),
        decodeRawFilterPage,
      ).pipe(
        Effect.map((page) => page.values ?? []),
        Effect.withSpan("JiraApi.searchFilters"),
      ),
    favouriteFilters: (identity) =>
      read(
        identity,
        HttpClientRequest.get("/rest/api/3/filter/favourite").pipe(
          HttpClientRequest.setUrlParams({ expand: FILTER_EXPAND }),
        ),
        decodeRawFilters,
      ).pipe(Effect.withSpan("JiraApi.favouriteFilters")),
    getFilter: (identity, id) =>
      read(
        identity,
        HttpClientRequest.get(`/rest/api/3/filter/${encodeURIComponent(id)}`).pipe(
          HttpClientRequest.setUrlParams({ expand: FILTER_EXPAND }),
        ),
        decodeRawFilter,
      ).pipe(Effect.withSpan("JiraApi.getFilter")),
    getFields: (identity) =>
      read(identity, HttpClientRequest.get("/rest/api/3/field"), decodeRawFields).pipe(
        Effect.withSpan("JiraApi.getFields"),
      ),
    createMetaIssueTypes: (identity, projectKey) =>
      read(
        identity,
        HttpClientRequest.get(
          `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
        ).pipe(HttpClientRequest.setUrlParams({ maxResults: "200" })),
        decodeRawCreateMetaIssueTypes,
      ).pipe(
        Effect.map((page) => page.issueTypes ?? page.values ?? []),
        Effect.withSpan("JiraApi.createMetaIssueTypes"),
      ),
    createIssue: (identity, fields) =>
      read(
        identity,
        HttpClientRequest.post("/rest/api/3/issue").pipe(
          HttpClientRequest.bodyJsonUnsafe({ fields }),
        ),
        decodeRawCreatedIssue,
      ).pipe(Effect.withSpan("JiraApi.createIssue")),
    editIssue: (identity, key, fields) =>
      // Jira answers 204 with no body.
      send(
        identity,
        HttpClientRequest.put(`/rest/api/3/issue/${encodeURIComponent(key)}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ fields }),
        ),
        () => Effect.void,
      ).pipe(Effect.withSpan("JiraApi.editIssue")),
    addComment: (identity, key, body) =>
      read(
        identity,
        HttpClientRequest.post(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ body }),
        ),
        decodeRawComment,
      ).pipe(Effect.withSpan("JiraApi.addComment")),
    transitionIssue: (identity, key, transitionId) =>
      // Jira answers 204 with no body.
      send(
        identity,
        HttpClientRequest.post(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ transition: { id: transitionId } }),
        ),
        () => Effect.void,
      ).pipe(Effect.withSpan("JiraApi.transitionIssue")),
    upsertRemoteLink: (identity, key, link) =>
      send(
        identity,
        HttpClientRequest.post(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            globalId: link.globalId,
            object: {
              url: link.url,
              title: link.title,
              ...(link.iconUrl === undefined
                ? {}
                : { icon: { url16x16: link.iconUrl, title: "T3 Code" } }),
            },
          }),
        ),
        () => Effect.void,
      ).pipe(Effect.withSpan("JiraApi.upsertRemoteLink")),
    deleteRemoteLink: (identity, key, globalId) =>
      // Jira answers 204 with no body.
      send(
        identity,
        HttpClientRequest.delete(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`).pipe(
          HttpClientRequest.setUrlParams({ globalId }),
        ),
        () => Effect.void,
      ).pipe(Effect.withSpan("JiraApi.deleteRemoteLink")),
  });
});

export const layer = Layer.effect(JiraApi, make);
