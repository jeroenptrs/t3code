import { FactoryId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  validateWorkItemSearch,
  workItemListInput,
  workItemStageBadgeVariant,
} from "./workItems.logic";

const factoryId = FactoryId.make("factory:project-api:nightly-triage");

describe("workItemListInput", () => {
  it.each([
    { raw: {}, expected: { factoryId } },
    {
      raw: { stage: "waiting", outcome: "active" },
      expected: { factoryId, stage: "waiting", outcome: "active" },
    },
    // A link from when roles were stages shows everything.
    { raw: { stage: "implement" }, expected: { factoryId } },
    { raw: { stage: "Shipped!", outcome: 3 }, expected: { factoryId } },
    { raw: { outcome: "done", stage: "" }, expected: { factoryId, outcome: "done" } },
  ])("reads $raw from the search params", ({ raw, expected }) => {
    expect(workItemListInput(factoryId, validateWorkItemSearch(raw))).toEqual(expected);
  });
});

describe("workItemStageBadgeVariant", () => {
  it.each([
    ["new", "default"],
    ["working", "default"],
    ["waiting", "warning"],
    ["done", "outline"],
    ["failed", "destructive"],
    ["dropped", "default"],
  ] as const)("maps %s to %s", (stage, variant) => {
    expect(workItemStageBadgeVariant(stage)).toBe(variant);
  });

  it("shows a dismissed failure as outline", () => {
    expect(workItemStageBadgeVariant("failed", true)).toBe("outline");
    expect(workItemStageBadgeVariant("waiting", true)).toBe("warning");
  });
});
