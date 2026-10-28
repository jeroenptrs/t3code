import { createContext, use } from "react";

import type { Route, ThreadRef } from "./stack";

export interface TvNavigation {
  readonly push: (route: Route) => void;
  readonly back: () => void;
  /** Opens a thread's terminal over the main view; Menu or `back` returns to the thread. */
  readonly openTerminal: (thread: ThreadRef, terminalId?: string) => void;
}

export const TvNavigationContext = createContext<TvNavigation | null>(null);

export function useTvNavigation(): TvNavigation {
  const navigation = use(TvNavigationContext);
  if (navigation === null) throw new Error("useTvNavigation needs TvApp's navigation provider.");
  return navigation;
}
