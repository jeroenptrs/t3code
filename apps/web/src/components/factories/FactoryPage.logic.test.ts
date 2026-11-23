import type { FactoryIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { issueCountByTab, validateFactoryPageSearch } from "./FactoryPage.logic";

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
      { tab: "work-items", stage: "working", outcome: "active", item: "work-item:1" },
      { tab: "work-items", stage: "working", outcome: "active", item: "work-item:1" },
    ],
    [{ tab: "work-items", stage: "Shipped!", outcome: 3 }, { tab: "work-items" }],
    [{ tab: "canvas", role: "Not A Role" }, {}],
    [
      { tab: "triggers", trigger: "scheduled-task:review" },
      { tab: "triggers", trigger: "scheduled-task:review" },
    ],
    // A trigger page belongs to the Triggers tab.
    [{ tab: "roles", trigger: "scheduled-task:review" }, { tab: "roles" }],
  ])("reads %j", (raw, expected) => {
    expect(validateFactoryPageSearch(raw)).toEqual(expected);
  });
});

const issue = (role: string | null, field: string | null, code = "unknown_model"): FactoryIssue =>
  ({ code, role, field, message: "" }) as FactoryIssue;

describe("issueCountByTab", () => {
  it("counts a role's issues on Roles and factory.json's on Settings", () => {
    const counts = issueCountByTab([
      issue("implement", "model"),
      issue("foreman", null),
      issue(null, "projects", "other_projects"),
    ]);
    expect(Object.fromEntries(counts)).toEqual({ roles: 2, settings: 1 });
  });
});
