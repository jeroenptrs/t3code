import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface ThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export type Route =
  | { readonly name: "home" }
  | { readonly name: "connections" }
  | { readonly name: "signIn" }
  | { readonly name: "environment"; readonly environmentId: EnvironmentId }
  | {
      readonly name: "thread";
      readonly thread: ThreadRef;
      /** The list the thread was opened from, in its order then, for Previous and Next. */
      readonly siblings: ReadonlyArray<ThreadRef>;
    };

/** Root first. Never empty: the root has nowhere to go back to, so Menu exits from there. */
export type Stack = readonly [Route, ...Route[]];

export type StackAction =
  | { readonly type: "push"; readonly route: Route }
  | { readonly type: "replace"; readonly route: Route }
  | { readonly type: "back" }
  /** Goes back only if the top route is `name`. */
  | { readonly type: "close"; readonly name: Route["name"] }
  | { readonly type: "reset"; readonly routes: Stack };

export const INITIAL_STACK: Stack = [{ name: "home" }];

export function stackReducer(stack: Stack, action: StackAction): Stack {
  const [root, ...above] = stack;
  switch (action.type) {
    case "push":
      return [...stack, action.route];
    case "replace":
      return above.length === 0 ? [action.route] : [root, ...above.slice(0, -1), action.route];
    case "back":
      return above.length === 0 ? stack : [root, ...above.slice(0, -1)];
    case "close":
      return topOf(stack).name === action.name ? stackReducer(stack, { type: "back" }) : stack;
    case "reset":
      return action.routes;
  }
}

/**
 * The stack as shown. With no saved environment Home has nothing to list, so the connections
 * screen stands in as the root, and a connections route right above it would repeat it.
 */
export function shownStack(stack: Stack, hasEnvironments: boolean): Stack {
  if (hasEnvironments || stack[0].name !== "home") return stack;
  const rest = stack.slice(1);
  return [{ name: "connections" }, ...(rest[0]?.name === "connections" ? rest.slice(1) : rest)];
}

export function topOf(stack: Stack): Route {
  return stack[stack.length - 1]!;
}

/** The thread before and after `thread` in the list it was opened from. */
export function threadNeighbours(route: Extract<Route, { name: "thread" }>): {
  readonly previous: ThreadRef | null;
  readonly next: ThreadRef | null;
} {
  const index = route.siblings.findIndex(
    (sibling) =>
      sibling.environmentId === route.thread.environmentId &&
      sibling.threadId === route.thread.threadId,
  );
  if (index === -1) return { previous: null, next: null };
  return {
    previous: route.siblings[index - 1] ?? null,
    next: route.siblings[index + 1] ?? null,
  };
}
