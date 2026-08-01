import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  makeRpcSessionFactory,
  remoteHttpClientLayer,
  type RemoteEnvironmentRequestError,
} from "@t3tools/client-runtime/rpc";
import {
  fetchRemoteSessionState,
  resolveRemoteWebSocketConnectionUrl,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { ConnectionAttemptError } from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type ClientOrchestrationCommand,
  type DispatchResult,
  type AuthSessionState,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type ServerConfig,
  type ThreadId,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/unstable/socket/Socket";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;

export type T3TransportErrorKind =
  | "authentication"
  | "authorization"
  | "invalid-request"
  | "not-found"
  | "internal"
  | "timeout"
  | "unavailable";

export class T3TransportError extends Error {
  readonly _tag = "T3TransportError";
  readonly kind: T3TransportErrorKind;
  override readonly cause: unknown;

  constructor(kind: T3TransportErrorKind, message: string, cause: unknown) {
    super(message);
    this.name = "T3TransportError";
    this.kind = kind;
    this.cause = cause;
  }
}

export interface T3Transport {
  readonly validateSession: () => Effect.Effect<AuthSessionState, T3TransportError>;
  readonly getShellSnapshot: () => Effect.Effect<OrchestrationShellSnapshot, T3TransportError>;
  readonly getThreadSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThreadDetailSnapshot | null, T3TransportError>;
  readonly dispatch: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<DispatchResult, T3TransportError>;
  readonly getServerConfig: () => Effect.Effect<ServerConfig, T3TransportError>;
  readonly listRefs: (
    input: VcsListRefsInput,
  ) => Effect.Effect<VcsListRefsResult, T3TransportError>;
  readonly switchRef: (
    input: VcsSwitchRefInput,
  ) => Effect.Effect<VcsSwitchRefResult, T3TransportError>;
  readonly dispatchBootstrap: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<DispatchResult, T3TransportError>;
}

export interface LiveT3TransportOptions {
  readonly httpBaseUrl: string;
  readonly readBearerCredential: Effect.Effect<string, CredentialReadError>;
  readonly timeoutMs?: number;
  readonly bootstrapTimeoutMs?: number;
}

export class CredentialReadError extends Error {
  readonly _tag = "CredentialReadError";
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CredentialReadError";
    this.cause = cause;
  }
}

export interface ServerConfigConnection {
  readonly getConfig: Effect.Effect<ServerConfig, T3TransportError>;
  readonly listRefs: (
    input: VcsListRefsInput,
  ) => Effect.Effect<VcsListRefsResult, T3TransportError>;
  readonly switchRef: (
    input: VcsSwitchRefInput,
  ) => Effect.Effect<VcsSwitchRefResult, T3TransportError>;
  readonly dispatchBootstrap: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<DispatchResult, T3TransportError>;
  readonly closed: Effect.Effect<never, Error>;
  readonly close: Effect.Effect<void>;
}

export const makeServerConfigConnectionManager = Effect.fn(
  "integrationRuntime.makeServerConfigConnectionManager",
)(function* (connect: () => Effect.Effect<ServerConfigConnection, T3TransportError>) {
  const mutex = yield* Semaphore.make(1);
  let generation = 0;
  let current: { readonly generation: number; readonly connection: ServerConfigConnection } | null =
    null;

  const getConnection = mutex.withPermits(1)(
    Effect.gen(function* () {
      if (current !== null) return current.connection;
      const connection = yield* connect();
      const connectionGeneration = ++generation;
      current = { generation: connectionGeneration, connection };
      yield* connection.closed.pipe(
        Effect.exit,
        Effect.andThen(
          mutex.withPermits(1)(
            Effect.sync(() => {
              if (current?.generation === connectionGeneration) current = null;
            }),
          ),
        ),
        Effect.ensuring(connection.close),
        Effect.forkDetach,
      );
      return connection;
    }),
  );

  const withConnection = <A>(
    use: (connection: ServerConfigConnection) => Effect.Effect<A, T3TransportError>,
  ) => getConnection.pipe(Effect.flatMap((connection) => use(connection)));

  return {
    getConfig: withConnection((connection) => connection.getConfig),
    listRefs: (input: VcsListRefsInput) =>
      withConnection((connection) => connection.listRefs(input)),
    switchRef: (input: VcsSwitchRefInput) =>
      withConnection((connection) => connection.switchRef(input)),
    dispatchBootstrap: (command: ClientOrchestrationCommand) =>
      withConnection((connection) => connection.dispatchBootstrap(command)),
  } as const;
});

const transportError = (cause: unknown): T3TransportError => {
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : null;
  switch (tag) {
    case "EnvironmentAuthInvalidError":
      return new T3TransportError("authentication", "T3 authentication failed.", cause);
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
    case "EnvironmentAuthorizationError":
    case "ConnectionBlockedError":
      return new T3TransportError("authorization", "T3 authorization failed.", cause);
    case "EnvironmentRequestInvalidError":
      return new T3TransportError("invalid-request", "T3 rejected an invalid request.", cause);
    case "EnvironmentResourceNotFoundError":
      return new T3TransportError("not-found", "The requested T3 resource was not found.", cause);
    case "EnvironmentInternalError":
      return new T3TransportError("internal", "T3 could not complete the operation.", cause);
    case "RemoteEnvironmentAuthTimeoutError":
      return new T3TransportError("timeout", "The T3 request timed out.", cause);
    default:
      return new T3TransportError("unavailable", "T3 is unavailable.", cause);
  }
};

const endpointUrl = (baseUrl: string, pathname: string): string => {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const websocketBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const makeLiveT3Transport = Effect.fn("integrationRuntime.makeLiveT3Transport")(function* (
  options: LiveT3TransportOptions,
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const httpLayer = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
  const rpcSessions = yield* makeRpcSessionFactory.pipe(
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
  );

  const withCredential = <A>(
    use: (
      credential: string,
    ) => Effect.Effect<
      A,
      RemoteEnvironmentRequestError | ConnectionAttemptError | CredentialReadError
    >,
  ): Effect.Effect<A, T3TransportError> =>
    Effect.gen(function* () {
      const credential = yield* options.readBearerCredential;
      const trimmed = credential.trim();
      if (trimmed.length === 0) {
        return yield* Effect.fail(
          new CredentialReadError("The T3 bearer credential file is empty."),
        );
      }
      return yield* use(trimmed);
    }).pipe(Effect.mapError(transportError));

  const getShellSnapshot = () =>
    withCredential((credential) =>
      Effect.gen(function* () {
        const client = yield* makeEnvironmentHttpApiClient(options.httpBaseUrl);
        return yield* executeEnvironmentHttpRequest(
          endpointUrl(options.httpBaseUrl, "/api/orchestration/shell"),
          timeoutMs,
          client.orchestration.shellSnapshot({
            headers: { authorization: `Bearer ${credential}` },
          }),
        );
      }).pipe(Effect.provide(httpLayer)),
    );

  const validateSession = () =>
    withCredential((credential) =>
      fetchRemoteSessionState({
        httpBaseUrl: options.httpBaseUrl,
        bearerToken: credential,
        timeoutMs,
      }).pipe(Effect.provide(httpLayer)),
    );

  const getThreadSnapshot = (threadId: ThreadId) =>
    withCredential((credential) =>
      Effect.gen(function* () {
        const client = yield* makeEnvironmentHttpApiClient(options.httpBaseUrl);
        return yield* executeEnvironmentHttpRequest(
          endpointUrl(
            options.httpBaseUrl,
            `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
          ),
          timeoutMs,
          client.orchestration.threadSnapshot({
            headers: { authorization: `Bearer ${credential}` },
            params: { threadId },
          }),
        ).pipe(
          Effect.map((snapshot) => snapshot as OrchestrationThreadDetailSnapshot | null),
          Effect.catch((error: RemoteEnvironmentRequestError) =>
            error._tag === "EnvironmentResourceNotFoundError"
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        );
      }).pipe(Effect.provide(httpLayer)),
    );

  const dispatch = (command: ClientOrchestrationCommand) =>
    withCredential((credential) =>
      Effect.gen(function* () {
        const client = yield* makeEnvironmentHttpApiClient(options.httpBaseUrl);
        return yield* executeEnvironmentHttpRequest(
          endpointUrl(options.httpBaseUrl, "/api/orchestration/dispatch"),
          timeoutMs,
          client.orchestration.dispatch({
            headers: { authorization: `Bearer ${credential}` },
            payload: command,
          } as Parameters<typeof client.orchestration.dispatch>[0]),
        );
      }).pipe(Effect.provide(httpLayer)),
    );

  const configManager = yield* makeServerConfigConnectionManager(() =>
    withCredential((credential) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        const connect = Effect.gen(function* () {
          const environment = yield* fetchRemoteEnvironmentDescriptor({
            httpBaseUrl: options.httpBaseUrl,
            timeoutMs,
          });
          const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
            wsBaseUrl: websocketBaseUrl(options.httpBaseUrl),
            httpBaseUrl: options.httpBaseUrl,
            bearerToken: credential,
            timeoutMs,
          });
          const connection: PreparedConnection = {
            environmentId: environment.environmentId,
            label: environment.label,
            httpBaseUrl: options.httpBaseUrl,
            socketUrl,
            httpAuthorization: { _tag: "Bearer", token: credential },
            target: {
              _tag: "PrimaryConnectionTarget",
              environmentId: environment.environmentId,
              label: environment.label,
              httpBaseUrl: options.httpBaseUrl,
              wsBaseUrl: websocketBaseUrl(options.httpBaseUrl),
            },
          };
          const session = yield* rpcSessions
            .connect(connection)
            .pipe(Effect.provideService(Scope.Scope, scope));
          yield* session.ready;
          const request = <A, E>(effect: Effect.Effect<A, E>, requestTimeoutMs = timeoutMs) =>
            effect.pipe(
              Effect.mapError(transportError),
              Effect.timeout(requestTimeoutMs),
              Effect.catchTag("TimeoutError", (cause) =>
                Effect.fail(new T3TransportError("timeout", "The T3 request timed out.", cause)),
              ),
            );
          return {
            getConfig: request(session.client[WS_METHODS.serverGetConfig]({})),
            listRefs: (input) => request(session.client[WS_METHODS.vcsListRefs](input)),
            switchRef: (input) => request(session.client[WS_METHODS.vcsSwitchRef](input)),
            dispatchBootstrap: (command) =>
              request(
                session.client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
                bootstrapTimeoutMs,
              ),
            closed: session.closed,
            close: Scope.close(scope, Exit.void),
          } satisfies ServerConfigConnection;
        });
        return yield* connect.pipe(
          Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
        );
      }).pipe(Effect.provide(httpLayer)),
    ),
  );

  const getServerConfig = () => configManager.getConfig;
  const listRefs = (input: VcsListRefsInput) => configManager.listRefs(input);
  const switchRef = (input: VcsSwitchRefInput) => configManager.switchRef(input);
  const dispatchBootstrap = (command: ClientOrchestrationCommand) =>
    configManager.dispatchBootstrap(command);

  return {
    validateSession,
    getShellSnapshot,
    getThreadSnapshot,
    dispatch,
    getServerConfig,
    listRefs,
    switchRef,
    dispatchBootstrap,
  } satisfies T3Transport;
});

export const REQUIRED_T3_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const;
