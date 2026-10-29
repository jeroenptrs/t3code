/**
 * Where focus last landed on the main screen: a sidebar item by key, or the conversation.
 * Sidebar items report their own focus; the conversation reports any focus inside it. Focus
 * in a sheet or another route reports nothing, so the last pane stands under it.
 */
export type PaneFocus =
  | { readonly pane: "sidebar"; readonly key: string }
  | { readonly pane: "conversation" }
  | null;

/** The sidebar's first item, where Menu exits instead of returning to the top. */
export const NEW_THREAD_FOCUS_KEY = "new-thread";

/** Which main screen owners hold Menu, as one value so a row-to-row move changes nothing. */
export type PaneMenuOwners = "none" | "sidebar" | "conversation";

export function paneMenuOwners(focus: PaneFocus): PaneMenuOwners {
  if (focus === null) return "none";
  if (focus.pane === "conversation") return "conversation";
  return focus.key === NEW_THREAD_FOCUS_KEY ? "none" : "sidebar";
}

export function createPaneFocus() {
  let focus: PaneFocus = null;
  let owners: PaneMenuOwners = "none";
  const listeners = new Set<() => void>();
  return {
    report(next: PaneFocus): void {
      focus = next;
      const nextOwners = paneMenuOwners(next);
      if (nextOwners === owners) return;
      owners = nextOwners;
      for (const listener of listeners) listener();
    },
    focus: (): PaneFocus => focus,
    owners: (): PaneMenuOwners => owners,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const paneFocus = createPaneFocus();

export const reportSidebarFocus = (key: string) => paneFocus.report({ pane: "sidebar", key });
export const reportConversationFocus = () => paneFocus.report({ pane: "conversation" });
