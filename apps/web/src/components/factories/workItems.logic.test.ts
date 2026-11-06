import { FactoryId, WorkItemError, WorkItemId, WorkItemTransitionError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  gateAnswerError,
  gateAnswerInput,
  validateWorkItemSearch,
  workItemFailureMessage,
  workItemListInput,
  workItemStageBadgeVariant,
} from "./workItems.logic";

const factoryId = FactoryId.make("factory:project-api:nightly-triage");

describe("workItemListInput", () => {
  it.each([
    { raw: {}, expected: { factoryId } },
    {
      raw: { stage: "waiting", role: "review", outcome: "active" },
      expected: { factoryId, stage: "waiting", role: "review", outcome: "active" },
    },
    { raw: { stage: "shipped", role: "triage", outcome: 3 }, expected: { factoryId } },
    { raw: { outcome: "done", stage: "" }, expected: { factoryId, outcome: "done" } },
  ])("reads $raw from the search params", ({ raw, expected }) => {
    expect(workItemListInput(factoryId, validateWorkItemSearch(raw))).toEqual(expected);
  });
});

describe("gateAnswerError", () => {
  it.each([
    { decision: "approved", note: "", expected: null },
    { decision: "rejected", note: "  ", expected: "Add a note to reject." },
    { decision: "rejected", note: "Out of scope", expected: null },
  ] as const)("$decision with note '$note'", ({ decision, note, expected }) => {
    expect(gateAnswerError(decision, note)).toBe(expected);
  });

  it("sends the note trimmed", () => {
    const workItemId = WorkItemId.make("work-item:1");
    expect(gateAnswerInput(workItemId, "approved", "  go ahead \n")).toEqual({
      workItemId,
      decision: "approved",
      note: "go ahead",
    });
  });
});

describe("workItemFailureMessage", () => {
  it.each([
    {
      error: new WorkItemError({ code: "no_gate", message: "No gate holds this item." }),
      expected: "No gate holds this item.",
    },
    {
      error: new WorkItemTransitionError({
        workItemId: WorkItemId.make("work-item:1"),
        from: "done",
        to: "dropped",
      }),
      expected: "The item cannot move from done to dropped.",
    },
    { error: "socket closed", expected: "The answer could not be sent." },
  ])("shows $expected", ({ error, expected }) => {
    expect(workItemFailureMessage(error, "The answer could not be sent.")).toBe(expected);
  });
});

describe("workItemStageBadgeVariant", () => {
  it.each([
    ["queued", "outline"],
    ["new", "default"],
    ["implement", "default"],
    ["review", "default"],
    ["waiting", "warning"],
    ["done", "outline"],
    ["failed", "destructive"],
    ["dropped", "default"],
  ] as const)("maps %s to %s", (stage, variant) => {
    expect(workItemStageBadgeVariant(stage)).toBe(variant);
  });
});
