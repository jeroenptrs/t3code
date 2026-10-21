const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. As a delegated child task, do not watch or poll PRs; return PR URLs, head SHA, and pending review/check state to your parent. Otherwise, when asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When monitoring is done and you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;

/**
 * Fork-only. One line per Jira tool family, so a later tool adds its own line. The server grants
 * the "jira" MCP capability only when Jira is configured on it.
 */
const JIRA_ISSUE_TOOL_GUIDANCE = [
  "When this thread's work is for a Jira issue (the user names a key such as ABC-123 or gives a browse URL), call link_jira_issue so T3 Code shows the issue with the thread. Linking an already-linked issue is safe.",
  "A branch whose name contains an issue key links that issue automatically.",
  "list_thread_jira_issues lists the issues linked to this thread.",
  "When asked to watch or follow a Jira issue, call watch_jira_issue and end your turn: T3 Code wakes you when someone else comments, its status changes or its assignee changes, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_jira_issue first so the thread returns to their inbox.",
  "The linking tools only record links in T3 Code.",
  "When the user wants issues created, a comment posted or an issue moved on their behalf, propose it with propose_jira_issues, propose_jira_comment or propose_jira_transition. The user reviews and approves it in T3 Code, and the change is made with their own Jira account. Do not also make the same change with jtk, and do not propose it again while it is pending.",
  "Use jtk, which acts as your own Jira identity when it is configured, for reads and for changes the user asks you to make as yourself.",
];

const JIRA_ISSUE_LINKING_INSTRUCTIONS = `<jira_issue_linking>
${JIRA_ISSUE_TOOL_GUIDANCE.map((line) => `- ${line}`).join("\n")}
</jira_issue_linking>`;

/**
 * Fork-only. What a good work package is for this team, for threads the server started to break
 * a Jira issue into work packages; the server grants those threads the "jira-breakdown" MCP
 * capability. The first message carries the issue and its planning context.
 */
const JIRA_BREAKDOWN_GUIDANCE = [
  "This thread breaks the Jira issue in its first message into work packages for the user to approve. Read the repository to understand the work, but do not edit files, commit, push, or open pull requests.",
  "Each package is independently mergeable: it can ship as its own pull request without waiting on another unmerged package. When one package builds on another, say so and state the order.",
  "Estimate each package in story points (storyPoints on the draft), consistent with the team's velocity given in the first message.",
  "Name each package with the parent's key for context, for example `ABC-12: <what this package does>`.",
  "Write each description in Markdown: a short why, then acceptance criteria as a checklist (`- [ ] ...`).",
  "Put the packages under the issue: when it is a story or task, create sub-tasks with parentKey set to the issue's key and a sub-task issue type the project lists; when it is an epic, create stories or tasks with parentKey set to the epic. When sub-tasks do not fit, put them under the epic the issue names, with parentKey set to that epic.",
  "Suggest a sprint with sprintId from the open sprints given, or leave it out.",
  "End by calling propose_jira_issues once with every package. If no sensible breakdown exists, do not propose anything; say why in your final message instead.",
];

const JIRA_BREAKDOWN_INSTRUCTIONS = `<jira_breakdown>
${JIRA_BREAKDOWN_GUIDANCE.map((line) => `- ${line}`).join("\n")}
</jira_breakdown>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly mcpCapabilities?: ReadonlySet<string> | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const jira = runtime.mcpCapabilities?.has("jira") ? `\n\n${JIRA_ISSUE_LINKING_INSTRUCTIONS}` : "";
  const breakdown = runtime.mcpCapabilities?.has("jira-breakdown")
    ? `\n\n${JIRA_BREAKDOWN_INSTRUCTIONS}`
    : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${jira}${breakdown}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
