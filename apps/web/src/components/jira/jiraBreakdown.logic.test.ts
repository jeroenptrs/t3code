import { EnvironmentId, JiraError, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  jiraBreakdownFailureToast,
  jiraBreakdownPaletteIssue,
  jiraBreakdownProjects,
  jiraIssueThreadProjects,
} from "./jiraBreakdown.logic";

const jiraEnvironmentId = EnvironmentId.make("jira-env");
const otherEnvironmentId = EnvironmentId.make("other-env");
const projects = [
  { environmentId: jiraEnvironmentId, id: "p-web", title: "web" },
  { environmentId: otherEnvironmentId, id: "p-remote", title: "api" },
  { environmentId: jiraEnvironmentId, id: "p-api", title: "api" },
];

describe("jiraIssueThreadProjects", () => {
  it("keeps the Jira environment's projects, by title", () => {
    expect(jiraIssueThreadProjects(projects, jiraEnvironmentId).map((p) => p.id)).toEqual([
      "p-api",
      "p-web",
    ]);
  });
});

describe("jiraBreakdownProjects", () => {
  it("uses the thread's project beside a thread", () => {
    expect(
      jiraBreakdownProjects({
        environmentId: jiraEnvironmentId,
        threadProjectId: ProjectId.make("p-thread"),
        projects,
      }),
    ).toEqual({ kind: "thread", projectId: "p-thread" });
  });

  it("offers the Jira environment's projects elsewhere", () => {
    const choice = jiraBreakdownProjects({
      environmentId: jiraEnvironmentId,
      threadProjectId: null,
      projects,
    });
    expect(choice.kind === "choose" ? choice.projects.map((p) => p.id) : null).toEqual([
      "p-api",
      "p-web",
    ]);
  });
});

describe("jiraBreakdownPaletteIssue", () => {
  const one = { site: "acme.atlassian.net", key: "ABC-1" };
  const two = { site: "acme.atlassian.net", key: "ABC-2" };

  it("prefers the issue open in the panel", () => {
    expect(jiraBreakdownPaletteIssue({ openIssue: two, linkedIssues: [one] })).toBe(two);
  });

  it("falls back to the only linked issue, and to nothing with several", () => {
    expect(jiraBreakdownPaletteIssue({ openIssue: null, linkedIssues: [one] })).toBe(one);
    expect(jiraBreakdownPaletteIssue({ openIssue: null, linkedIssues: [one, two] })).toBeNull();
    expect(jiraBreakdownPaletteIssue({ openIssue: null, linkedIssues: [] })).toBeNull();
  });
});

describe("jiraBreakdownFailureToast", () => {
  const issue = { site: "acme.atlassian.net", key: "ABC-1" };

  it("points a missing token at Account settings", () => {
    const failure = new JiraError({ reason: "personal-token-required", message: "No token." });
    expect(jiraBreakdownFailureToast(failure, issue)).toEqual({
      title: "Could not break down ABC-1",
      description: "Add your Jira token for acme.atlassian.net in Settings → Account first.",
    });
  });

  it("shows the server's message otherwise", () => {
    const failure = new JiraError({
      reason: "invalid",
      message: "The project has no default model.",
    });
    expect(jiraBreakdownFailureToast(failure, issue).description).toBe(
      "The project has no default model.",
    );
    expect(jiraBreakdownFailureToast(new Error("socket closed"), issue).description).toBe(
      "Could not reach the server. Try again.",
    );
  });
});
