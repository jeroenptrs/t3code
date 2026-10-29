import { describe, expect, it, vi } from "vite-plus/test";

import { createMenuScope } from "./menuScope";
import { createPaneFocus, NEW_THREAD_FOCUS_KEY, type PaneMenuOwners } from "./paneFocus";

/** MainScreen's two owners, pushed and popped from the pane focus the way its effects do. */
function setup() {
  const scope = createMenuScope();
  const focus = createPaneFocus();
  const onSidebarMenu = vi.fn();
  const onConversationMenu = vi.fn();
  let pop: (() => void) | null = null;
  const sync = (owners: PaneMenuOwners) => {
    pop?.();
    pop =
      owners === "sidebar"
        ? scope.push({ kind: "sidebar", onMenu: onSidebarMenu })
        : owners === "conversation"
          ? scope.push({ kind: "conversation", onMenu: onConversationMenu })
          : null;
  };
  const onChange = vi.fn(() => sync(focus.owners()));
  focus.subscribe(onChange);
  return { scope, focus, onChange, onSidebarMenu, onConversationMenu };
}

describe("paneFocus", () => {
  it("holds Menu for the sidebar on any item but New thread", () => {
    const { scope, focus, onSidebarMenu } = setup();
    expect(scope.handlesMenu()).toBe(false);
    focus.report({ pane: "sidebar", key: "env:thread-3" });
    expect(scope.kinds()).toEqual(["sidebar"]);
    scope.dispatch();
    expect(onSidebarMenu).toHaveBeenCalledTimes(1);
    focus.report({ pane: "sidebar", key: NEW_THREAD_FOCUS_KEY });
    expect(scope.handlesMenu()).toBe(false);
  });

  it("holds Menu on a row even when focus never visited New thread", () => {
    const { scope, focus } = setup();
    focus.report({ pane: "conversation" });
    focus.report({ pane: "sidebar", key: "env:selected" });
    expect(scope.kinds()).toEqual(["sidebar"]);
  });

  it("swaps the sidebar owner for the conversation owner and back without leaving one behind", () => {
    const { scope, focus, onConversationMenu } = setup();
    focus.report({ pane: "sidebar", key: "connections" });
    focus.report({ pane: "conversation" });
    expect(scope.kinds()).toEqual(["conversation"]);
    scope.dispatch();
    expect(onConversationMenu).toHaveBeenCalledTimes(1);
    focus.report({ pane: "sidebar", key: "env:selected" });
    expect(scope.kinds()).toEqual(["sidebar"]);
    focus.report({ pane: "sidebar", key: NEW_THREAD_FOCUS_KEY });
    expect(scope.kinds()).toEqual([]);
  });

  it("notifies only when the owners change, not on every row move", () => {
    const { focus, onChange } = setup();
    focus.report({ pane: "sidebar", key: "env:a" });
    focus.report({ pane: "sidebar", key: "env:b" });
    focus.report({ pane: "sidebar", key: "shelf:settled" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(focus.focus()).toEqual({ pane: "sidebar", key: "shelf:settled" });
  });
});
