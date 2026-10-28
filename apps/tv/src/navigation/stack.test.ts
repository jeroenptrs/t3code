import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { INITIAL_STACK, shownStack, stackReducer, threadNeighbours, type Route } from "./stack";

const office = EnvironmentId.make("office");
const ref = (id: string) => ({ environmentId: office, threadId: ThreadId.make(id) });
const siblings = [ref("a"), ref("b"), ref("c")];
const threadRoute = (id: string): Extract<Route, { name: "thread" }> => ({
  name: "thread",
  thread: ref(id),
  siblings,
});

describe("stackReducer", () => {
  it("pushes and goes back one level at a time", () => {
    const environment: Route = { name: "environment", environmentId: office };
    const pushed = stackReducer(stackReducer(INITIAL_STACK, { type: "push", route: environment }), {
      type: "push",
      route: threadRoute("a"),
    });
    expect(pushed).toEqual([{ name: "home" }, environment, threadRoute("a")]);
    const once = stackReducer(pushed, { type: "back" });
    expect(once).toEqual([{ name: "home" }, environment]);
    expect(stackReducer(once, { type: "back" })).toEqual(INITIAL_STACK);
  });

  it("stays on the root when going back from it", () => {
    expect(stackReducer(INITIAL_STACK, { type: "back" })).toBe(INITIAL_STACK);
  });

  it("replaces the top so a sibling thread keeps the same way back", () => {
    const stack = stackReducer(INITIAL_STACK, { type: "push", route: threadRoute("a") });
    const replaced = stackReducer(stack, { type: "replace", route: threadRoute("b") });
    expect(replaced).toEqual([{ name: "home" }, threadRoute("b")]);
    expect(stackReducer(replaced, { type: "back" })).toEqual(INITIAL_STACK);
  });

  it("closes the top route only when it is the named one", () => {
    const stack = stackReducer(INITIAL_STACK, { type: "push", route: { name: "connections" } });
    expect(stackReducer(stack, { type: "close", name: "connections" })).toEqual(INITIAL_STACK);
    const opened = stackReducer(INITIAL_STACK, { type: "push", route: threadRoute("a") });
    expect(stackReducer(opened, { type: "close", name: "connections" })).toBe(opened);
  });

  it("resets to a new root", () => {
    const stack = stackReducer(INITIAL_STACK, { type: "push", route: threadRoute("a") });
    expect(stackReducer(stack, { type: "reset", routes: [{ name: "connections" }] })).toEqual([
      { name: "connections" },
    ]);
  });
});

describe("shownStack", () => {
  it("shows connections as the root while nothing is saved", () => {
    expect(shownStack(INITIAL_STACK, false)).toEqual([{ name: "connections" }]);
    expect(shownStack([{ name: "home" }, { name: "connections" }], false)).toEqual([
      { name: "connections" },
    ]);
    expect(
      shownStack([{ name: "home" }, { name: "connections" }, { name: "signIn" }], false),
    ).toEqual([{ name: "connections" }, { name: "signIn" }]);
  });

  it("leaves the stack alone once an environment is saved", () => {
    const stack = stackReducer(INITIAL_STACK, { type: "push", route: { name: "connections" } });
    expect(shownStack(stack, true)).toBe(stack);
  });
});

describe("threadNeighbours", () => {
  it("finds the previous and next thread in the list it came from", () => {
    expect(threadNeighbours(threadRoute("b"))).toEqual({ previous: ref("a"), next: ref("c") });
    expect(threadNeighbours(threadRoute("a"))).toEqual({ previous: null, next: ref("b") });
    expect(threadNeighbours(threadRoute("c"))).toEqual({ previous: ref("b"), next: null });
  });

  it("has no neighbours when the thread left the list", () => {
    expect(threadNeighbours(threadRoute("z"))).toEqual({ previous: null, next: null });
  });
});
