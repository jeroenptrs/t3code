// Jira issue key: project key of 2+ chars, then a number without leading zero. Like GitLab's
// Jira integration, the match may not touch a letter or digit on either side, so `ABC-12x` and
// `fooABC-1` are ignored while `ABC-123-fix` and `feature/ABC-123` match.
const TEXT_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-[1-9]\d*(?![A-Za-z0-9])/g;
const BRANCH_KEY = /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]+-[1-9]\d*(?![A-Za-z0-9])/g;

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

/** The single key a branch name carries, or null when it carries none or several distinct ones. */
export function jiraIssueKeyFromBranch(branch: string): string | null {
  const keys = new Set(
    (branch.match(BRANCH_KEY) ?? [])
      .map((key) => key.toUpperCase())
      .filter((key) => !isBranchFalsePositive(key)),
  );
  return keys.size === 1 ? ([...keys][0] ?? null) : null;
}
