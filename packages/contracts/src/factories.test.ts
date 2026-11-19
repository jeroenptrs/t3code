import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import {
  canTransitionWorkItem,
  isReservedFactoryRoleName,
  type WorkItemGate,
  WorkItemStage,
} from "./factories.ts";

const none: WorkItemGate = { state: "none" };
const waitingFor = (resumeStage: "working" | "done"): WorkItemGate => ({
  state: "waiting",
  question: "Merge it?",
  resumeStage,
  askedAt: "2026-11-05T00:00:00.000Z",
});

const allowed: Record<WorkItemStage, ReadonlyArray<WorkItemStage>> = {
  new: ["working", "waiting", "failed", "dropped"],
  working: ["waiting", "done", "failed", "dropped"],
  waiting: ["failed", "dropped"],
  done: [],
  failed: [],
  dropped: [],
};
const stages = Object.keys(allowed) as ReadonlyArray<WorkItemStage>;

describe("canTransitionWorkItem", () => {
  it.each(stages.flatMap((from) => stages.map((to) => [from, to] as const)))(
    "%s to %s follows the table",
    (from, to) => {
      expect(canTransitionWorkItem(from, to, none)).toBe(allowed[from].includes(to));
    },
  );

  it("lets a waiting item resume only to the stage its gate names", () => {
    expect(canTransitionWorkItem("waiting", "working", waitingFor("working"))).toBe(true);
    expect(canTransitionWorkItem("waiting", "done", waitingFor("working"))).toBe(false);
    expect(canTransitionWorkItem("waiting", "done", waitingFor("done"))).toBe(true);
    // An answered gate no longer holds a resume stage open.
    expect(
      canTransitionWorkItem("waiting", "working", {
        state: "answered",
        question: "Merge it?",
        decision: "approved",
        note: "",
        answeredAt: "2026-11-05T00:00:00.000Z",
        resumeStage: "working",
      }),
    ).toBe(false);
  });
});

describe("work item stages", () => {
  it("are not role names, and no role takes a stage's name", () => {
    const decode = Schema.decodeUnknownSync(WorkItemStage);
    expect(() => decode("implement")).toThrow();
    expect(() => decode("queued")).toThrow();
    expect([...stages, "queued", "implement"].map(isReservedFactoryRoleName)).toEqual([
      ...stages.map(() => true),
      true,
      false,
    ]);
  });
});
