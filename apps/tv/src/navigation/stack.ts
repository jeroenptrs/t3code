import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface ThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * Screens above the main view. Threads are not routes: the main view's sidebar selects one and
 * shows it beside the list, so Menu from a thread moves focus to the sidebar instead.
 */
export type Route =
  | { readonly name: "home" }
  | { readonly name: "connections" }
  | { readonly name: "signIn" }
  | {
      readonly name: "terminal";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      /** Omitted for the thread's default terminal. */
      readonly terminalId?: string;
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
