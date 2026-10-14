import type { JiraCreateMeta, JiraIssueDraft, JiraProposal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  approvedJiraProposal,
  initialJiraProposalEdits,
  jiraDraftEditErrors,
  jiraIssueTypeOptions,
  jiraProposalApproveLabel,
  jiraProposalDisplay,
  jiraProposalFailureMessage,
  jiraProposalOutcome,
  jiraSprintIdFromOption,
  jiraSprintOptions,
  type JiraProposalEdits,
} from "./jiraProposal.logic";

const SITE = "acme.atlassian.net";

function draft(summary: string, patch: Partial<JiraIssueDraft> = {}): JiraIssueDraft {
  return {
    projectKey: "ABC",
    issueType: "Story",
    summary,
    description: null,
    parentKey: null,
    labels: [],
    storyPoints: null,
    sprintId: null,
    assigneeAccountId: null,
    ...patch,
  };
}

const createIssues: JiraProposal = {
  kind: "create-issues",
  site: SITE,
  issues: [draft("First", { storyPoints: 3, sprintId: 7 }), draft("Second"), draft("Third")],
};

function draftEdits(proposal: JiraProposal) {
  const edits = initialJiraProposalEdits(proposal);
  if (edits.kind !== "create-issues") throw new Error("expected drafts");
  return edits;
}

describe("jiraProposalDisplay", () => {
  it("lets only the thread that holds a proposal decide it", () => {
    expect(jiraProposalDisplay({ proposalStatus: "pending" }, "local").kind).toBe("editable");
    expect(jiraProposalDisplay({ proposalStatus: "failed" }, "local").kind).toBe("editable");
    expect(jiraProposalDisplay({ proposalStatus: "pending" }, "inherited").kind).toBe(
      "pending-elsewhere",
    );
    expect(jiraProposalDisplay({ proposalStatus: "failed" }, "synthetic").kind).toBe(
      "failed-elsewhere",
    );
    expect(jiraProposalDisplay({ proposalStatus: "approved" }, "local").kind).toBe("writing");
    expect(jiraProposalDisplay({ proposalStatus: "applied" }, "inherited").kind).toBe("applied");
  });
});

describe("approvedJiraProposal", () => {
  it("approves the agent's drafts unchanged when nothing was edited", () => {
    expect(approvedJiraProposal(createIssues, initialJiraProposalEdits(createIssues))).toEqual(
      createIssues,
    );
  });

  it("applies edits and drops removed drafts", () => {
    const edits = draftEdits(createIssues);
    const edited: JiraProposalEdits = {
      kind: "create-issues",
      drafts: [
        { ...edits.drafts[0]!, summary: "  Renamed ", storyPoints: "", sprintId: null },
        { ...edits.drafts[2]!, issueType: "Bug", parentKey: " abc-9 ", storyPoints: "1.5" },
      ],
    };
    expect(approvedJiraProposal(createIssues, edited)).toEqual({
      ...createIssues,
      issues: [
        draft("Renamed"),
        draft("Third", { issueType: "Bug", parentKey: "ABC-9", storyPoints: 1.5 }),
      ],
    });
  });

  it("refuses invalid or empty drafts", () => {
    const edits = draftEdits(createIssues);
    const withDraft = (patch: Partial<(typeof edits.drafts)[number]>): JiraProposalEdits => ({
      kind: "create-issues",
      drafts: [{ ...edits.drafts[0]!, ...patch }],
    });
    expect(approvedJiraProposal(createIssues, withDraft({ summary: "  " }))).toBeNull();
    expect(approvedJiraProposal(createIssues, withDraft({ storyPoints: "-1" }))).toBeNull();
    expect(approvedJiraProposal(createIssues, withDraft({ parentKey: "nope" }))).toBeNull();
    expect(approvedJiraProposal(createIssues, { kind: "create-issues", drafts: [] })).toBeNull();
    expect(jiraDraftEditErrors({ ...edits.drafts[0]!, summary: "", issueType: "" })).toEqual({
      summary: "Add a summary",
      issueType: "Pick an issue type",
    });
  });

  it("sends drafts an earlier approval created back unchanged", () => {
    const edits = draftEdits(createIssues);
    const result = {
      issues: [{ site: SITE, key: "ABC-1", url: `https://${SITE}/browse/ABC-1`, draftIndex: 0 }],
    };
    const edited: JiraProposalEdits = {
      kind: "create-issues",
      drafts: [{ ...edits.drafts[0]!, summary: "" }, edits.drafts[1]!, edits.drafts[2]!],
    };
    expect(approvedJiraProposal(createIssues, edited, result)).toEqual(createIssues);
  });

  it("trims comments and treats a blank transition comment as none", () => {
    const comment: JiraProposal = { kind: "comment", site: SITE, key: "ABC-1", body: "Done" };
    expect(approvedJiraProposal(comment, { kind: "comment", body: " Shipped " })).toEqual({
      ...comment,
      body: "Shipped",
    });
    expect(approvedJiraProposal(comment, { kind: "comment", body: "   " })).toBeNull();
    const transition: JiraProposal = {
      kind: "transition",
      site: SITE,
      key: "ABC-1",
      transitionId: "31",
      transitionName: "Done",
      comment: "Merged",
    };
    expect(approvedJiraProposal(transition, { kind: "transition", comment: " " })).toEqual({
      ...transition,
      comment: null,
    });
  });
});

describe("jiraProposalApproveLabel", () => {
  it("counts the drafts left and says Retry after a failure", () => {
    const edits = draftEdits(createIssues);
    expect(jiraProposalApproveLabel(createIssues, edits, false)).toBe("Create 3 issues");
    expect(
      jiraProposalApproveLabel(
        createIssues,
        { kind: "create-issues", drafts: [edits.drafts[0]!] },
        false,
      ),
    ).toBe("Create 1 issue");
    expect(jiraProposalApproveLabel(createIssues, edits, true)).toBe("Retry");
  });
});

describe("jiraProposalOutcome", () => {
  it("lists created issues in draft order", () => {
    const outcome = jiraProposalOutcome(createIssues, {
      issues: [
        { site: SITE, key: "ABC-2", url: "u2", draftIndex: 1 },
        { site: SITE, key: "ABC-1", url: "u1", draftIndex: 0 },
      ],
    });
    expect(outcome.verb).toBe("Created");
    expect(outcome.issues.map((issue) => issue.key)).toEqual(["ABC-1", "ABC-2"]);
  });

  it("names the proposal's issue when the result carries none", () => {
    const outcome = jiraProposalOutcome(
      {
        kind: "transition",
        site: SITE,
        key: "ABC-1",
        transitionId: "31",
        transitionName: "Done",
        comment: null,
      },
      undefined,
    );
    expect(outcome).toEqual({
      verb: "Moved",
      issues: [{ site: SITE, key: "ABC-1", url: `https://${SITE}/browse/ABC-1` }],
      tail: "to Done",
    });
  });
});

describe("select options", () => {
  const meta: JiraCreateMeta = {
    issueTypes: [
      { id: "1", name: "Story", subtask: false },
      { id: "2", name: "Bug", subtask: false },
    ],
    sprints: [{ id: 7, name: "Sprint 7", state: "active" }],
  };

  it("keeps the draft's own issue type when the project lacks it", () => {
    expect(jiraIssueTypeOptions(meta, "Story").map((option) => option.value)).toEqual([
      "Story",
      "Bug",
    ]);
    expect(jiraIssueTypeOptions(meta, "Epic").map((option) => option.value)).toEqual([
      "Epic",
      "Story",
      "Bug",
    ]);
    expect(jiraIssueTypeOptions(null, "Task")).toEqual([{ value: "Task", label: "Task" }]);
  });

  it("offers no sprint first and keeps an unknown sprint by id", () => {
    expect(jiraSprintOptions(meta, 7).map((option) => option.label)).toEqual([
      "No sprint",
      "Sprint 7",
    ]);
    expect(jiraSprintOptions(meta, 12).map((option) => option.label)).toEqual([
      "No sprint",
      "Sprint 12",
      "Sprint 7",
    ]);
    expect(jiraSprintIdFromOption(jiraSprintOptions(meta, null)[0]!.value)).toBeNull();
    expect(jiraSprintIdFromOption("12")).toBe(12);
  });
});

describe("jiraProposalFailureMessage", () => {
  it("passes Jira's own message through and hides transport failures", () => {
    expect(
      jiraProposalFailureMessage({
        _tag: "JiraError",
        reason: "personal-token-required",
        message: "Add your Jira token first.",
      }),
    ).toBe("Add your Jira token first.");
    expect(jiraProposalFailureMessage(new Error("socket closed"))).toBe(
      "Could not reach the server. Try again.",
    );
  });
});
