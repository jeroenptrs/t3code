import { useEffect, useEffectEvent } from "react";

/**
 * Who answers the Siri Remote's Menu button. With no owner the app is at its root and tvOS
 * exits on Menu; with one, App holds the Menu key and sends each press to the top owner.
 */
export type MenuOwnerKind = "conversation" | "route" | "sheet" | "imageViewer";

export interface MenuOwner {
  readonly kind: MenuOwnerKind;
  readonly onMenu: () => void;
}

// Effects run children first, so a sheet can push before the conversation it sits in. Layers
// keep overlays above routes, and routes above the conversation, whatever the push order.
const LAYERS: Record<MenuOwnerKind, number> = {
  conversation: 0,
  route: 1,
  sheet: 2,
  imageViewer: 2,
};

export function createMenuScope() {
  let stack: ReadonlyArray<MenuOwner> = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    /** Adds `owner` above every owner on its layer or below; the returned function removes it. */
    push(owner: MenuOwner): () => void {
      const layer = LAYERS[owner.kind];
      const above = stack.findIndex((candidate) => LAYERS[candidate.kind] > layer);
      const index = above === -1 ? stack.length : above;
      stack = [...stack.slice(0, index), owner, ...stack.slice(index)];
      emit();
      return () => {
        if (!stack.includes(owner)) return;
        stack = stack.filter((candidate) => candidate !== owner);
        emit();
      };
    },
    top: (): MenuOwner | null => stack.at(-1) ?? null,
    /** Whether App holds the Menu key: false only at the root, where Menu exits. */
    handlesMenu: (): boolean => stack.length > 0,
    /** Sends a Menu press to the top owner; false when there is none. */
    dispatch(): boolean {
      const top = stack.at(-1);
      if (top === undefined) return false;
      top.onMenu();
      return true;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const menuScope = createMenuScope();

/** Owns Menu while mounted and `active`, calling the latest `onMenu`. */
export function useMenuOwner(kind: MenuOwnerKind, onMenu: () => void, active = true): void {
  const handle = useEffectEvent(onMenu);
  useEffect(() => {
    if (!active) return;
    return menuScope.push({ kind, onMenu: () => handle() });
  }, [active, kind]);
}
