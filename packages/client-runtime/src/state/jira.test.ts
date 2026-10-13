import type { ThreadJiraIssueLink } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  JIRA_NOT_CONFIGURED,
  jiraIssueUrl,
  parseJiraIssueInput,
  resolveJiraCapabilities,
  visibleThreadJiraIssues,
} from "./jira.ts";

const SITE = "acme.atlassian.net";

describe("parseJiraIssueInput", () => {
  it("puts a bare key on the default site, whatever its case", () => {
    expect(parseJiraIssueInput(" abc-123 ", SITE)).toEqual({ site: SITE, key: "ABC-123" });
    expect(parseJiraIssueInput("AB2-7", "Acme.Atlassian.net")).toEqual({
      site: SITE,
      key: "AB2-7",
    });
  });

  it("refuses a bare key when there is no site to put it on", () => {
    expect(parseJiraIssueInput("ABC-123", null)).toBeNull();
  });

  it("reads browse links, keeping the link's own site", () => {
    expect(parseJiraIssueInput("https://other.atlassian.net/browse/ABC-123", SITE)).toEqual({
      site: "other.atlassian.net",
      key: "ABC-123",
    });
    expect(parseJiraIssueInput("acme.atlassian.net/browse/abc-9?focusedCommentId=1", null)).toEqual(
      { site: SITE, key: "ABC-9" },
    );
  });

  it("reads project issue links and board links with a selected issue", () => {
    expect(
      parseJiraIssueInput(
        "https://acme.atlassian.net/jira/software/c/projects/ABC/issues/ABC-42",
        null,
      ),
    ).toEqual({ site: SITE, key: "ABC-42" });
    expect(
      parseJiraIssueInput(
        "https://acme.atlassian.net/jira/software/c/projects/ABC/boards/1?selectedIssue=ABC-5",
        null,
      ),
    ).toEqual({ site: SITE, key: "ABC-5" });
  });

  it("rejects text and links that name no issue", () => {
    expect(parseJiraIssueInput("", SITE)).toBeNull();
    expect(parseJiraIssueInput("ABC", SITE)).toBeNull();
    expect(parseJiraIssueInput("ABC-0", SITE)).toBeNull();
    expect(parseJiraIssueInput("1BC-3", SITE)).toBeNull();
    expect(parseJiraIssueInput("https://acme.atlassian.net/jira/your-work", SITE)).toBeNull();
    expect(parseJiraIssueInput("https://acme.atlassian.net/browse/", SITE)).toBeNull();
    expect(parseJiraIssueInput("ftp://acme.atlassian.net/browse/ABC-1", SITE)).toBeNull();
  });
});

describe("jiraIssueUrl", () => {
  it("links to the issue's browse page", () => {
    expect(jiraIssueUrl({ site: SITE, key: "ABC-1" })).toBe(
      "https://acme.atlassian.net/browse/ABC-1",
    );
  });
});

describe("visibleThreadJiraIssues", () => {
  const link = (key: string, source: ThreadJiraIssueLink["source"]): ThreadJiraIssueLink => ({
    site: SITE,
    key,
    source,
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: null,
  });

  it("hides dismissed branch links and keeps the rest in order", () => {
    expect(
      visibleThreadJiraIssues([
        link("ABC-1", "branch"),
        link("ABC-2", "branch-dismissed"),
        link("ABC-3", "manual"),
        link("ABC-4", "agent"),
      ]).map((entry) => entry.key),
    ).toEqual(["ABC-1", "ABC-3", "ABC-4"]);
    expect(visibleThreadJiraIssues(undefined)).toEqual([]);
  });
});

describe("resolveJiraCapabilities", () => {
  const configured = { ...JIRA_NOT_CONFIGURED, configured: true };

  it("is unknown until the server first answers", () => {
    expect(resolveJiraCapabilities(AsyncResult.initial(true))).toBeNull();
  });

  it("treats a failure, such as a server that predates Jira, as not configured", () => {
    expect(resolveJiraCapabilities(AsyncResult.failure(Cause.die("unknown method")))).toEqual(
      JIRA_NOT_CONFIGURED,
    );
  });

  it("keeps the last answer through a later failure", () => {
    const previous = Option.some(AsyncResult.success(configured));
    expect(
      resolveJiraCapabilities(AsyncResult.failureWithPrevious(Cause.die("offline"), { previous })),
    ).toEqual(configured);
  });
});
