import { describe, expect, it } from "vite-plus/test";

import {
  JIRA_COMMENT_MAX_LENGTH,
  jiraCommentToPost,
  jiraIssueWriteAccess,
} from "./jiraIssueWrite.logic";

const credential = {
  site: "acme.atlassian.net",
  account: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastVerifiedAt: null,
  error: null,
};

describe("jiraIssueWriteAccess", () => {
  it("enables writes with a token for the issue's site and the operate grant", () => {
    expect(
      jiraIssueWriteAccess({
        capabilities: { personalTokens: true, personalCredential: credential },
        canOperate: true,
        site: "ACME.atlassian.net",
      }),
    ).toBe("enabled");
  });

  it("asks for a token only when the session can store one", () => {
    const base = { canOperate: true, site: "acme.atlassian.net" };
    expect(
      jiraIssueWriteAccess({
        ...base,
        capabilities: { personalTokens: true, personalCredential: null },
      }),
    ).toBe("needs-token");
    expect(
      jiraIssueWriteAccess({
        ...base,
        capabilities: { personalTokens: true, personalCredential: credential },
        site: "other.atlassian.net",
      }),
    ).toBe("needs-token");
    expect(
      jiraIssueWriteAccess({
        ...base,
        capabilities: { personalTokens: false, personalCredential: null },
      }),
    ).toBe("hidden");
  });

  it("shows nothing without the operate grant or capabilities", () => {
    expect(
      jiraIssueWriteAccess({
        capabilities: { personalTokens: true, personalCredential: credential },
        canOperate: false,
        site: "acme.atlassian.net",
      }),
    ).toBe("hidden");
    expect(
      jiraIssueWriteAccess({ capabilities: null, canOperate: true, site: "acme.atlassian.net" }),
    ).toBe("hidden");
  });
});

describe("jiraCommentToPost", () => {
  it("trims and rejects empty or oversized drafts", () => {
    expect(jiraCommentToPost("  Looks good\n")).toBe("Looks good");
    expect(jiraCommentToPost(" \n ")).toBeNull();
    expect(jiraCommentToPost("x".repeat(JIRA_COMMENT_MAX_LENGTH + 1))).toBeNull();
    expect(jiraCommentToPost("x".repeat(JIRA_COMMENT_MAX_LENGTH))).not.toBeNull();
  });
});
