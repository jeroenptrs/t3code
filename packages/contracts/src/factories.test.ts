import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import {
  canTransitionWorkItem,
  isWorkItemRoleStage,
  WorkItemAdvanceStage,
  type WorkItemGate,
  WorkItemResumeStage,
  WorkItemStage,
} from "./factories.ts";

const none: WorkItemGate = { state: "none" };
const waitingFor = (resumeStage: string): WorkItemGate => ({
  state: "waiting",
  question: "Merge it?",
  resumeStage,
  askedAt: "2026-11-05T00:00:00.000Z",
});

// `analysis` stands for any role; `foreman` and `queued` are never an item's next stage.
const allowed: Record<string, ReadonlyArray<string>> = {
  new: ["implement", "review", "analysis", "waiting", "failed", "dropped"],
  implement: ["review", "analysis", "waiting", "done", "failed", "dropped"],
  review: ["implement", "analysis", "waiting", "done", "failed", "dropped"],
  analysis: ["implement", "review", "waiting", "done", "failed", "dropped"],
  waiting: ["failed", "dropped"],
  done: [],
  failed: [],
  dropped: [],
  foreman: [],
  queued: [],
};
const stages = Object.keys(allowed);

describe("canTransitionWorkItem", () => {
  it.each(stages.flatMap((from) => stages.map((to) => [from, to])))(
    "%s to %s follows the table",
    (from, to) => {
      expect(canTransitionWorkItem(from, to, none)).toBe(allowed[from]!.includes(to));
    },
  );

  it("lets a waiting item resume only to the stage its gate names", () => {
    expect(canTransitionWorkItem("waiting", "review", waitingFor("review"))).toBe(true);
    expect(canTransitionWorkItem("waiting", "implement", waitingFor("review"))).toBe(false);
    expect(canTransitionWorkItem("waiting", "done", waitingFor("done"))).toBe(true);
    expect(canTransitionWorkItem("waiting", "triage", waitingFor("triage"))).toBe(true);
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

describe("work item stages", () => {
  it("decode stored stages and tell a role's from a fixed one", () => {
    const decode = Schema.decodeUnknownSync(WorkItemStage);
    for (const stage of ["new", "implement", "review", "waiting", "done", "queued", "triage"]) {
      expect(decode(stage)).toBe(stage);
    }
    expect(() => decode("Not A Stage")).toThrow();
    expect(
      [
        "implement",
        "triage",
        "new",
        "waiting",
        "done",
        "failed",
        "dropped",
        "queued",
        "foreman",
      ].map(isWorkItemRoleStage),
    ).toEqual([true, true, false, false, false, false, false, false, false]);
  });

  it("let the Foreman advance to a role or an end, and a gate resume to a role or done", () => {
    const advance = Schema.is(WorkItemAdvanceStage);
    const resume = Schema.is(WorkItemResumeStage);
    expect(["triage", "done", "failed", "dropped", "new", "waiting"].map(advance)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(["triage", "done", "failed", "dropped", "waiting"].map(resume)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
