import { describe, expect, it } from "vite-plus/test";

import { jiraIssueKeyFromBranch, parseJiraIssueKeys, parseJiraIssueKeysFrom } from "./issueKeys.ts";

describe("jiraIssueKeyFromBranch", () => {
  it.each([
    ["ABC-123", "ABC-123"],
    ["feature/ABC-123-add-login", "ABC-123"],
    ["feature/abc-123-login", "ABC-123"],
    ["jeroen/abc-123", "ABC-123"],
    ["ABC-123_fix", "ABC-123"],
    ["feature/my_proj-12-login", "MY_PROJ-12"],
    ["fix.AB2-7.typo", "AB2-7"],
    ["abc-123-and-abc-123", "ABC-123"],
  ])("finds the key in %s", (branch, key) => {
    expect(jiraIssueKeyFromBranch(branch)).toBe(key);
  });

  it("takes the leftmost key when the branch names several", () => {
    expect(jiraIssueKeyFromBranch("ABC-1-and-DEF-2")).toBe("ABC-1");
    expect(jiraIssueKeyFromBranch("abc-123-bump-react-to-19")).toBe("ABC-123");
  });

  it.each([
    "main",
    "feature/add-login",
    "utf-8",
    "release-2024",
    "hotfix-12",
    "v1-2",
    "fix/utf-8-handling",
  ])("ignores %s", (branch) => {
    expect(jiraIssueKeyFromBranch(branch)).toBeNull();
  });

  it("keeps keys whose number looks like a year", () => {
    expect(jiraIssueKeyFromBranch("feature/proj-2001-login")).toBe("PROJ-2001");
  });

  it("still finds the key next to a false positive", () => {
    expect(jiraIssueKeyFromBranch("abc-12/utf-8")).toBe("ABC-12");
  });

  it("rejects leading zeros and glued neighbours", () => {
    expect(jiraIssueKeyFromBranch("abc-0123")).toBeNull();
    expect(jiraIssueKeyFromBranch("abc-12x")).toBeNull();
    expect(jiraIssueKeyFromBranch("fooabc-12")).toBe("FOOABC-12");
  });
});

describe("parseJiraIssueKeys", () => {
  it("returns distinct keys in first-seen order", () => {
    expect(parseJiraIssueKeys("Fixes DEF-2, relates to ABC-1 and DEF-2 again")).toEqual([
      "DEF-2",
      "ABC-1",
    ]);
  });

  it("is case-sensitive so prose does not match", () => {
    expect(parseJiraIssueKeys("utf-8 covid-19 abc-123 UTF-8")).toEqual(["UTF-8"]);
  });

  it("follows adjacency rules", () => {
    expect(parseJiraIssueKeys("ABC-123-fix")).toEqual(["ABC-123"]);
    expect(parseJiraIssueKeys("(ABC-123) [DEF-4]: GHI-5.")).toEqual(["ABC-123", "DEF-4", "GHI-5"]);
    expect(parseJiraIssueKeys("ABC-12x")).toEqual([]);
    expect(parseJiraIssueKeys("ABC-123abc")).toEqual([]);
    expect(parseJiraIssueKeys("fooXABC-1")).toEqual([]);
    expect(parseJiraIssueKeys("1ABC-1")).toEqual([]);
  });

  it("accepts underscores in project keys after the first letter", () => {
    expect(parseJiraIssueKeys("See MY_PROJ-12 and _AB-1 and A_B-3")).toEqual([
      "MY_PROJ-12",
      "A_B-3",
    ]);
    expect(parseJiraIssueKeys("foo_ABC-1")).toEqual([]);
  });

  it("rejects leading zeros and one-character project keys", () => {
    expect(parseJiraIssueKeys("ABC-0123 ABC-0 A-1")).toEqual([]);
  });
});

describe("parseJiraIssueKeysFrom", () => {
  it("merges keys across texts and skips missing ones", () => {
    expect(
      parseJiraIssueKeysFrom(["feat ABC-1", null, undefined, "", "DEF-2 and ABC-1", "GHI-3"]),
    ).toEqual(["ABC-1", "DEF-2", "GHI-3"]);
  });
});
