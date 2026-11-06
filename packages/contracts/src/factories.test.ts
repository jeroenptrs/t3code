import { describe, expect, it } from "vite-plus/test";

import {
  canTransitionWorkItem,
  type WorkItemGate,
  WorkItemStage,
  type WorkItemStage as Stage,
} from "./factories.ts";

const none: WorkItemGate = { state: "none" };
const waitingFor = (resumeStage: "implement" | "review" | "done"): WorkItemGate => ({
  state: "waiting",
  question: "Merge it?",
  resumeStage,
  askedAt: "2026-11-05T00:00:00.000Z",
});

const allowed: Record<Stage, ReadonlyArray<Stage>> = {
  queued: ["new"],
  new: ["implement", "waiting", "failed", "dropped"],
  implement: ["review", "waiting", "failed", "dropped"],
  review: ["implement", "waiting", "done", "failed"],
  waiting: ["failed", "dropped"],
  done: [],
  failed: [],
  dropped: [],
};

describe("canTransitionWorkItem", () => {
  it.each(WorkItemStage.literals.flatMap((from) => WorkItemStage.literals.map((to) => [from, to])))(
    "%s to %s follows the table",
    (from, to) => {
      expect(canTransitionWorkItem(from, to, none)).toBe(allowed[from].includes(to));
    },
  );

  it("lets a waiting item resume only to the stage its gate names", () => {
    expect(canTransitionWorkItem("waiting", "review", waitingFor("review"))).toBe(true);
    expect(canTransitionWorkItem("waiting", "implement", waitingFor("review"))).toBe(false);
    expect(canTransitionWorkItem("waiting", "done", waitingFor("done"))).toBe(true);
    // An answered gate no longer holds a resume stage open.
    expect(
      canTransitionWorkItem("waiting", "review", {
        state: "answered",
        question: "Merge it?",
        decision: "approved",
        note: "",
        answeredAt: "2026-11-05T00:00:00.000Z",
        resumeStage: "review",
      }),
    ).toBe(false);
  });
});
