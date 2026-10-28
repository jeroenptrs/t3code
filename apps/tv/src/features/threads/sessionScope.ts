import {
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry, type Atom } from "effect/reactivity";

/** Whether a loaded session grants `scope`. Loading or failed reads as not granted. */
export function sessionResultGrants(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  const session = Option.getOrNull(AsyncResult.value(result));
  return result._tag !== "Failure" && session !== null && sessionGrantsScope(session, scope);
}

/**
 * Whether the session grants `scope`, waiting for it to load when nothing has read it yet, as
 * client-runtime's commandPermissions authorize does. A one-shot get of an unmounted session
 * atom returns Initial while its fetch starts.
 */
export function awaitSessionScope(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<AuthSessionState, unknown>>,
  scope: AuthEnvironmentScope,
): Promise<boolean> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* AtomRegistry.mount(registry, atom);
        const session = yield* AtomRegistry.getResult(registry, atom, {
          suspendOnWaiting: false,
        }).pipe(
          Effect.timeoutOption(6_000),
          Effect.orElseSucceed(() => Option.none<AuthSessionState>()),
        );
        return Option.isSome(session) && sessionGrantsScope(session.value, scope);
      }),
    ),
  );
}
