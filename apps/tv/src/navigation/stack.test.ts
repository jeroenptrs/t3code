import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { INITIAL_STACK, shownStack, stackReducer, type Route } from "./stack";

const office = EnvironmentId.make("office");
const terminal = (id: string): Route => ({
  name: "terminal",
  environmentId: office,
  threadId: ThreadId.make(id),
});

describe("stackReducer", () => {
  it("pushes and goes back one level at a time", () => {
    const pushed = stackReducer(
      stackReducer(INITIAL_STACK, { type: "push", route: { name: "connections" } }),
      { type: "push", route: { name: "signIn" } },
    );
    expect(pushed).toEqual([{ name: "home" }, { name: "connections" }, { name: "signIn" }]);
    const once = stackReducer(pushed, { type: "back" });
    expect(once).toEqual([{ name: "home" }, { name: "connections" }]);
    expect(stackReducer(once, { type: "back" })).toEqual(INITIAL_STACK);
  });

  it("stays on the root when going back from it", () => {
    expect(stackReducer(INITIAL_STACK, { type: "back" })).toBe(INITIAL_STACK);
  });

  it("opens a terminal over the main view and returns to it", () => {
    const opened = stackReducer(INITIAL_STACK, { type: "push", route: terminal("a") });
    expect(opened).toEqual([{ name: "home" }, terminal("a")]);
    expect(stackReducer(opened, { type: "back" })).toEqual(INITIAL_STACK);
  });

  it("replaces the top so another terminal keeps the same way back", () => {
    const stack = stackReducer(INITIAL_STACK, { type: "push", route: terminal("a") });
    const replaced = stackReducer(stack, { type: "replace", route: terminal("b") });
    expect(replaced).toEqual([{ name: "home" }, terminal("b")]);
    expect(stackReducer(replaced, { type: "back" })).toEqual(INITIAL_STACK);
  });

  it("closes the top route only when it is the named one", () => {
    const stack = stackReducer(INITIAL_STACK, { type: "push", route: { name: "connections" } });
    expect(stackReducer(stack, { type: "close", name: "connections" })).toEqual(INITIAL_STACK);
    const opened = stackReducer(INITIAL_STACK, { type: "push", route: terminal("a") });
    expect(stackReducer(opened, { type: "close", name: "connections" })).toBe(opened);
  });

  it("resets to a new root", () => {
    const stack = stackReducer(INITIAL_STACK, { type: "push", route: terminal("a") });
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
