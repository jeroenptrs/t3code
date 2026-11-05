import { EnvironmentId, FactoryId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { factoryNameError, showsFactoriesTab } from "./factories.logic";

const projectId = ProjectId.make("project-api");
const existing = [{ projectId, name: "nightly-triage" }];

describe("factoryNameError", () => {
  it.each([
    { name: "  ", expected: "Enter a name." },
    { name: "a".repeat(65), expected: "Use 64 characters or fewer." },
    { name: "Nightly", expected: "Use lowercase letters" },
    { name: "nightly--triage", expected: "Use lowercase letters" },
    { name: "-nightly", expected: "Use lowercase letters" },
    { name: "nightly triage", expected: "Use lowercase letters" },
    { name: "nightly-triage", expected: "This project already has a factory with this name." },
    { name: " release-2 ", expected: null },
  ])("returns $expected for $name", ({ name, expected }) => {
    const error = factoryNameError(name, existing, projectId);
    if (expected === null) expect(error).toBeNull();
    else expect(error).toContain(expected);
  });

  it("allows a name another project already uses", () => {
    expect(factoryNameError("nightly-triage", existing, ProjectId.make("project-web"))).toBeNull();
  });
});

describe("showsFactoriesTab", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const factory = {
    id: FactoryId.make("factory:project-api:nightly-triage"),
    projectId,
    name: "nightly-triage",
    issueCount: 0,
    scheduledTaskIds: [],
    threadIds: [],
    attention: { gatesWaiting: 0, failedRuns: 0, questions: 0, total: 0 },
  };

  it.each([
    { label: "no environment answered", factories: null, canManage: true, expected: false },
    { label: "an operator with no factories", factories: [], canManage: false, expected: false },
    { label: "an administrator with no factories", factories: [], canManage: true, expected: true },
    { label: "an operator with a factory", factories: [factory], canManage: false, expected: true },
  ])("is $expected for $label", ({ factories, canManage, expected }) => {
    expect(showsFactoriesTab([{ environmentId, factories, canManage }])).toBe(expected);
  });
});
