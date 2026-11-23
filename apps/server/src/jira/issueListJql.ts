import type { IssueInvolvement, IssueListSort, IssueListState } from "@t3tools/contracts";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/** A JQL string literal: backslashes and quotes escaped, control characters flattened to spaces. */
export function jqlString(value: string): string {
  const escaped = value
    .replace(CONTROL_CHARACTERS, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}

// Jira reads these as search syntax inside a `~` value and rejects the query when they do not
// balance, so free text keeps its words and loses its operators.
const TEXT_SEARCH_SYNTAX = /[+\-&|!(){}[\]^~*?:\\"/]/g;

/** Free text as plain words, or null when nothing but search syntax was typed. */
function searchWords(query: string): string | null {
  const words = query.replace(TEXT_SEARCH_SYNTAX, " ").replace(/\s+/g, " ").trim();
  return words.length === 0 ? null : words;
}

// The reader identity is the only account a listing is read as, so "mine" is always Jira's own
// `currentUser()` and never a name a client sent.
const INVOLVEMENT_CLAUSE: Record<Exclude<IssueInvolvement, "all">, string> = {
  assigned: "assignee = currentUser()",
  authored: "reporter = currentUser()",
  mentioned: "watcher = currentUser()",
};

/**
 * The JQL behind a tracker-neutral issue listing. Every value a client supplies becomes a quoted
 * JQL string, so none of them can add a clause, a function or an ORDER BY of its own.
 */
export function buildIssueListJql(input: {
  /** A Jira project key. */
  readonly scope: string;
  readonly state: IssueListState;
  readonly involvement: IssueInvolvement;
  readonly labels?: ReadonlyArray<string> | undefined;
  /** An assignee as an issue names them: a display name or an account id. */
  readonly assignee?: string | undefined;
  readonly query?: string | undefined;
  readonly sort: IssueListSort;
}): string {
  const words = input.query === undefined ? null : searchWords(input.query);
  const clauses = [
    `project = ${jqlString(input.scope.trim())}`,
    ...(input.state === "all"
      ? []
      : [input.state === "closed" ? "statusCategory = Done" : "statusCategory != Done"]),
    ...(input.involvement === "all" ? [] : [INVOLVEMENT_CLAUSE[input.involvement]]),
    ...(input.assignee === undefined ? [] : [`assignee = ${jqlString(input.assignee)}`]),
    ...(input.labels ?? []).map((label) => `labels = ${jqlString(label)}`),
    ...(words === null ? [] : [`text ~ ${jqlString(words)}`]),
  ];
  return `${clauses.join(" AND ")} ORDER BY ${input.sort === "created" ? "created" : "updated"} DESC`;
}
