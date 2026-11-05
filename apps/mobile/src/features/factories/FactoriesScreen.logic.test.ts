import { EnvironmentId, ProjectId, makeFactoryId, type FactorySummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { factoryAttentionTotal, factoryListSections, hasFactories } from "./FactoriesScreen.logic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");
const PROJECT = ProjectId.make("project-1");

function factory(name: string, total: number): FactorySummary {
  return {
    id: makeFactoryId(PROJECT, name),
    projectId: PROJECT,
    name,
    issueCount: 0,
    scheduledTaskIds: [],
    threadIds: [],
    attention: { gatesWaiting: 0, failedRuns: total, questions: 0, total },
  };
}

const sections = (lists: Parameters<typeof factoryListSections>[0]["lists"]) =>
  factoryListSections({
    lists,
    environmentLabel: (environmentId) => `label:${environmentId}`,
    projectTitle: (environmentId) => (environmentId === ENVIRONMENT_A ? "T3 Code" : null),
  }).map((section) => ({
    title: section.title,
    rows: section.rows.map((row) => [row.factory.name, row.projectTitle]),
  }));

describe("factoryListSections", () => {
  it("leaves the only environment untitled", () => {
    expect(sections([{ environmentId: ENVIRONMENT_A, factories: [factory("ship", 0)] }])).toEqual([
      { title: null, rows: [["ship", "T3 Code"]] },
    ]);
  });

  it("titles each environment once two can report, and drops those without factories", () => {
    expect(
      sections([
        { environmentId: ENVIRONMENT_A, factories: [factory("ship", 1), factory("triage", 0)] },
        { environmentId: ENVIRONMENT_B, factories: [] },
      ]),
    ).toEqual([
      {
        title: "label:environment-a",
        rows: [
          ["ship", "T3 Code"],
          ["triage", "T3 Code"],
        ],
      },
    ]);
  });
});

describe("the entry point's badge and visibility", () => {
  it("sums attention across environments and hides with no factories", () => {
    const lists = [
      { environmentId: ENVIRONMENT_A, factories: [factory("ship", 2), factory("triage", 0)] },
      { environmentId: ENVIRONMENT_B, factories: [factory("docs", 3)] },
    ];
    expect(factoryAttentionTotal(lists)).toBe(5);
    expect(hasFactories(lists)).toBe(true);
    expect(hasFactories([{ environmentId: ENVIRONMENT_A, factories: [] }])).toBe(false);
    expect(factoryAttentionTotal([])).toBe(0);
  });
});
