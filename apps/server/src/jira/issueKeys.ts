// Jira issue key: project key of 2+ chars, then a number without leading zero. Like GitLab's
// Jira integration, the match may not touch a letter or digit on either side, so `ABC-12x` and
// `fooABC-1` are ignored while `ABC-123-fix` and `feature/ABC-123` match. Project keys may hold
// `_` after their first letter, so `my_proj-12` reads as MY_PROJ-12 rather than PROJ-12; after
// the number `_` is a separator, so `abc-1_fix` works.
const TEXT_KEY = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]+-[1-9]\d*(?![A-Za-z0-9])/g;
const BRANCH_KEY = /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]+-[1-9]\d*(?![A-Za-z0-9])/g;

// Lowercase branch names make ordinary tokens look like keys: `utf-8` and friends, versions
// like `v1-2`, and branch-type words like `release-2024`. Prose parsing is uppercase-only and
// needs none of this.
const BRANCH_NON_PROJECTS = new Set([
  "UTF",
  "ISO",
  "SHA",
  "RFC",
  "CVE",
  "RELEASE",
  "HOTFIX",
  "BUGFIX",
  "FEATURE",
  "FIX",
  "FEAT",
  "CHORE",
]);

function isBranchFalsePositive(key: string): boolean {
  const project = key.slice(0, key.lastIndexOf("-"));
  return BRANCH_NON_PROJECTS.has(project) || /^V\d+$/.test(project);
}

/** Distinct Jira issue keys mentioned in `text`, uppercase, in first-seen order. */
export function parseJiraIssueKeys(text: string): string[] {
  return [...new Set(text.match(TEXT_KEY) ?? [])];
}

/** Keys mentioned across several texts (branch, title, description), distinct, first-seen order. */
export function parseJiraIssueKeysFrom(texts: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(texts.flatMap((text) => (text ? parseJiraIssueKeys(text) : [])))];
}

/**
 * The key a branch name carries, or null when it carries none. Keys conventionally come first, so
 * the leftmost wins: `abc-123-bump-react-to-19` is ABC-123, not TO-19.
 */
export function jiraIssueKeyFromBranch(branch: string): string | null {
  return (
    (branch.match(BRANCH_KEY) ?? [])
      .map((key) => key.toUpperCase())
      .find((key) => !isBranchFalsePositive(key)) ?? null
  );
}
