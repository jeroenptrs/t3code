const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: one link_pull_request per PR, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
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

/** Omit model and effort when the harness manages them dynamically. */
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
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in T3 Code's files viewer.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${jira}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
