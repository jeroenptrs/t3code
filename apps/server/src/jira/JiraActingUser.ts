/**
 * The signed-in portal user a tracker-neutral issue call is made for. The WebSocket handlers set
 * it; MCP tools, workflows and background work never do, so they read as the reader identity and
 * cannot write to Jira.
 */
import type { AuthUserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const JiraActingUser = Context.Reference<AuthUserId | null>("t3/jira/JiraActingUser", {
  defaultValue: () => null,
});

/** The service with every call made for one user, so no handler can forget to name them. */
export function asActingUser<S extends object>(service: S, userId: AuthUserId | undefined): S {
  if (userId === undefined) return service;
  return Object.fromEntries(
    Object.entries(service).map(([name, member]) => [
      name,
      typeof member !== "function"
        ? member
        : (...args: ReadonlyArray<unknown>) => {
            const result: unknown = member(...args);
            return Effect.isEffect(result)
              ? Effect.provideService(result, JiraActingUser, userId)
              : result;
          },
    ]),
  ) as S;
}
