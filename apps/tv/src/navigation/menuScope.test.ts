import { describe, expect, it, vi } from "vite-plus/test";

import { createMenuScope } from "./menuScope";

describe("menuScope", () => {
  it("lets Menu exit only when nothing owns it", () => {
    const scope = createMenuScope();
    expect(scope.handlesMenu()).toBe(false);
    expect(scope.dispatch()).toBe(false);
    const pop = scope.push({ kind: "conversation", onMenu: () => {} });
    expect(scope.handlesMenu()).toBe(true);
    pop();
    expect(scope.handlesMenu()).toBe(false);
  });

  it("sends Menu to the newest owner on the top layer", () => {
    const scope = createMenuScope();
    const conversation = vi.fn();
    const sheet = vi.fn();
    const popConversation = scope.push({ kind: "conversation", onMenu: conversation });
    const popSheet = scope.push({ kind: "sheet", onMenu: sheet });
    expect(scope.dispatch()).toBe(true);
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(conversation).not.toHaveBeenCalled();
    popSheet();
    scope.dispatch();
    expect(conversation).toHaveBeenCalledTimes(1);
    popConversation();
    expect(scope.dispatch()).toBe(false);
  });

  it("keeps a sheet above a conversation that pushed after it", () => {
    const scope = createMenuScope();
    scope.push({ kind: "sheet", onMenu: () => {} });
    scope.push({ kind: "route", onMenu: () => {} });
    scope.push({ kind: "conversation", onMenu: () => {} });
    expect(scope.top()?.kind).toBe("sheet");
  });

  it("removes an owner from the middle without disturbing the rest", () => {
    const scope = createMenuScope();
    const popFirst = scope.push({ kind: "sheet", onMenu: () => {} });
    const second = { kind: "sheet" as const, onMenu: () => {} };
    scope.push(second);
    popFirst();
    popFirst();
    expect(scope.top()).toBe(second);
    expect(scope.handlesMenu()).toBe(true);
  });

  it("notifies subscribers on every change", () => {
    const scope = createMenuScope();
    const listener = vi.fn();
    const unsubscribe = scope.subscribe(listener);
    const pop = scope.push({ kind: "imageViewer", onMenu: () => {} });
    pop();
    pop();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    scope.push({ kind: "route", onMenu: () => {} });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the sidebar below the conversation", () => {
    const scope = createMenuScope();
    scope.push({ kind: "conversation", onMenu: () => {} });
    scope.push({ kind: "sidebar", onMenu: () => {} });
    expect(scope.top()?.kind).toBe("conversation");
  });
});
