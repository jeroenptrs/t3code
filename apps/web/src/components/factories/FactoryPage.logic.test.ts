import type { FactoryIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canSaveDefinition, issueCountByTab, validateFactoryPageSearch } from "./FactoryPage.logic";

describe("validateFactoryPageSearch", () => {
  it.each([
    [{}, {}],
    [{ tab: "overview" }, {}],
    [
      { tab: "roles", role: "implement" },
      { tab: "roles", role: "implement" },
    ],
    // A role page belongs to the Roles tab, and filters to Work items.
    [{ tab: "skills", role: "implement", stage: "new" }, { tab: "skills" }],
    [
      { tab: "work-items", stage: "triage", outcome: "active", item: "work-item:1" },
      { tab: "work-items", stage: "triage", outcome: "active", item: "work-item:1" },
    ],
    [{ tab: "work-items", stage: "Shipped!", outcome: 3 }, { tab: "work-items" }],
    [{ tab: "canvas", role: "Not A Role" }, {}],
  ])("reads %j", (raw, expected) => {
    expect(validateFactoryPageSearch(raw)).toEqual(expected);
  });
});

const issue = (role: string | null, field: string | null, code = "unknown_model"): FactoryIssue =>
  ({ code, role, field, message: "" }) as FactoryIssue;

describe("issueCountByTab", () => {
  it("counts a role's issues on Roles, triggers on Triggers, and factory.json on Settings", () => {
    const counts = issueCountByTab([
      issue("implement", "model"),
      issue("foreman", null),
      issue(null, "triggers", "unknown_scheduled_task"),
      issue(null, "projects", "unknown_project"),
    ]);
    expect(Object.fromEntries(counts)).toEqual({ roles: 2, triggers: 1, settings: 1 });
  });
});

describe("canSaveDefinition", () => {
  it("refuses saves over a factory.json that could not be read", () => {
    expect(canSaveDefinition({ issues: [issue(null, null, "invalid_definition")] })).toBe(false);
    expect(canSaveDefinition({ issues: [issue(null, "projects", "invalid_definition")] })).toBe(
      true,
    );
  });
});
