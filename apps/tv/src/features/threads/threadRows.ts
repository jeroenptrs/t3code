import {
  subagentGroupSummary,
  summarizeSubagentStatuses,
} from "@t3tools/client-runtime/state/subagent-display";
import { isLiveSubagentTurnItem } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ChatAttachment, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

type VisibleTurnItem = OrchestrationV2ThreadProjection["visibleTurnItems"][number];

export interface ThreadImageAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
}

/** One row of the TV thread feed, derived from a visible turn item. */
export type ThreadRow =
  | {
      readonly kind: "user";
      readonly key: string;
      readonly text: string;
      readonly images: ReadonlyArray<ThreadImageAttachment>;
    }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly text: string;
      readonly images: ReadonlyArray<ThreadImageAttachment>;
      readonly streaming: boolean;
    }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      readonly preview: string;
      readonly status: string;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly text: string;
      readonly tone: "muted" | "warning" | "danger";
    }
  | {
      /** Consecutive subagent items of one provider turn, grouped the way web groups them. */
      readonly kind: "subagents";
      readonly key: string;
      readonly label: string;
      readonly statusSummary: string;
      readonly active: boolean;
      readonly failed: boolean;
    }
  | {
      /** A settled turn's work, folded behind its duration the way mobile folds it. */
      readonly kind: "fold";
      readonly key: string;
      readonly runId: string;
      readonly label: string;
      readonly expanded: boolean;
    };

/** The thread's latest run, as `deriveThreadActivityRun` summarizes it. */
export interface ThreadRowsRun {
  readonly runId: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ThreadRowsOptions {
  readonly latestRun?: ThreadRowsRun | null;
  /** A provider-native subagent thread's runless work is still going. */
  readonly runlessWorkActive?: boolean;
  readonly expandedRunIds?: ReadonlySet<string>;
}

const PREVIEW_LENGTH = 120;

const NO_IMAGES: ReadonlyArray<ThreadImageAttachment> = [];

function imageAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ReadonlyArray<ThreadImageAttachment> {
  const images = (attachments ?? [])
    .filter((attachment) => attachment.mimeType.toLowerCase().startsWith("image/"))
    .map(({ id, name, mimeType }) => ({ id, name, mimeType }));
  return images.length > 0 ? images : NO_IMAGES;
}

function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_LENGTH
    ? `${collapsed.slice(0, PREVIEW_LENGTH - 1)}…`
    : collapsed;
}

function previewUnknown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return oneLine(value);
  if (typeof value !== "object") return oneLine(String(value));
  // Prefer the argument a reader recognizes over the raw JSON of every argument.
  const record = value as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const field = record[key];
    if (typeof field === "string" && field.trim().length > 0) return oneLine(field);
  }
  try {
    return oneLine(JSON.stringify(value));
  } catch {
    return "";
  }
}

const toolRow = (
  key: string,
  item: VisibleTurnItem["item"],
  name: string,
  preview: string,
): ThreadRow => ({
  kind: "tool",
  key,
  name,
  preview: oneLine(preview),
  status: item.status,
});

/**
 * The same turn item can show twice, once local and once inherited from a fork's parent, so the
 * item id alone repeats. Source thread and source item identify a visible row, as the history
 * merge keys them.
 */
function rowKey(entry: VisibleTurnItem): string {
  return `${entry.sourceThreadId}:${entry.sourceItemId}`;
}

function toRow(entry: VisibleTurnItem): ThreadRow | null {
  const item = entry.item;
  const key = rowKey(entry);
  const tool = (name: string, preview: string) => toolRow(key, item, name, preview);
  switch (item.type) {
    case "user_message":
      return {
        kind: "user",
        key,
        text: item.text,
        images: imageAttachments(item.attachments),
      };
    case "assistant_message": {
      const images = imageAttachments(item.attachments);
      if (item.text.length === 0 && images.length === 0 && !item.streaming) return null;
      return {
        kind: "assistant",
        key,
        text: item.text,
        images,
        streaming: item.streaming,
      };
    }
    case "proposed_plan":
      return {
        kind: "assistant",
        key,
        text: item.markdown,
        images: NO_IMAGES,
        streaming: item.streaming,
      };
    case "command_execution":
      return tool("Run", item.input);
    case "dynamic_tool":
      return tool(item.toolName ?? "Tool", previewUnknown(item.input));
    case "file_change": {
      const counts = [
        item.additions === undefined ? null : `+${item.additions}`,
        item.deletions === undefined ? null : `-${item.deletions}`,
      ].filter((part) => part !== null);
      return tool("Edit", [item.fileName, ...counts].join(" "));
    }
    case "file_search":
      return tool("Search files", item.pattern ?? "");
    case "web_search":
      return tool("Web search", (item.patterns ?? []).join(", "));
    case "todo_list": {
      const done = item.steps.filter((step) => step.status === "completed").length;
      return tool("Todo", `${done}/${item.steps.length} done`);
    }
    case "approval_request":
      return {
        kind: "notice",
        key,
        text: `Approval ${item.status === "pending" || item.status === "waiting" ? "requested" : item.status}: ${oneLine(item.prompt ?? item.reason ?? item.requestKind)}`,
        tone: "warning",
      };
    case "user_input_request":
      return {
        kind: "notice",
        key,
        text: `Question: ${oneLine(item.questions.map((question) => question.question).join(" · "))}`,
        tone: "warning",
      };
    case "error":
      return { kind: "notice", key, text: item.failure.message, tone: "danger" };
    case "system_notice":
    case "run_interrupt_request":
    case "run_interrupt_result":
      return { kind: "notice", key, text: item.message, tone: "muted" };
    case "notification":
      return { kind: "notice", key, text: item.summary, tone: "muted" };
    case "compaction":
      return { kind: "notice", key, text: "Context compacted", tone: "muted" };
    case "reasoning":
      return item.text.trim().length === 0 ? null : tool("Thought", item.text);
    default:
      // Checkpoints, handoffs, forks, and items newer than this client stay hidden.
      return null;
  }
}

const rowCache = new WeakMap<VisibleTurnItem, ThreadRow | null>();

type SubagentItem = Extract<VisibleTurnItem["item"], { type: "subagent" }>;

function subagentGroupRow(key: string, members: ReadonlyArray<SubagentItem>): ThreadRow {
  const summary = subagentGroupSummary(members);
  return {
    kind: "subagents",
    key,
    label: summary.label,
    statusSummary: summarizeSubagentStatuses(members.map((member) => member.status)),
    active: summary.active,
    failed: summary.failed,
  };
}

function cachedRow(entry: VisibleTurnItem): ThreadRow | null {
  let row = rowCache.get(entry);
  if (row === undefined) {
    row = toRow(entry);
    rowCache.set(entry, row);
  }
  return row;
}

interface TurnFold {
  readonly runId: string;
  readonly label: string;
  readonly hidden: ReadonlySet<VisibleTurnItem>;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

function unsettledRunId(run: ThreadRowsRun | null): string | null {
  if (run === null || run.status === "queued") return null;
  return run.completedAt === null || ACTIVE_RUN_STATUSES.has(run.status) ? run.runId : null;
}

const itemStart = (item: VisibleTurnItem["item"]) =>
  DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);

const itemEnd = (item: VisibleTurnItem["item"]) =>
  item.type === "assistant_message" ? DateTime.toEpochMillis(item.updatedAt) : itemStart(item);

const isFailedRootError = (item: VisibleTurnItem["item"]) =>
  item.type === "error" && item.status === "failed" && item.parentItemId === null;

/** Items mobile keeps outside a fold: they matter after the turn, or they mark it. */
function staysVisible(item: VisibleTurnItem["item"]): boolean {
  return (
    item.type === "compaction" ||
    item.type === "system_notice" ||
    item.type === "proposed_plan" ||
    item.type === "notification" ||
    isFailedRootError(item)
  );
}

/** Subagents in a batch with a live member, which outlives its settled launching turn. */
function liveSubagentItems(items: ReadonlyArray<VisibleTurnItem>): ReadonlySet<VisibleTurnItem> {
  const live = new Set<VisibleTurnItem>();
  let batch: Array<VisibleTurnItem> = [];
  const flush = () => {
    if (batch.some((entry) => isLiveSubagentTurnItem(entry.item))) {
      for (const entry of batch) live.add(entry);
    }
    batch = [];
  };
  for (const entry of items) {
    const item = entry.item;
    const previous = batch.at(-1)?.item;
    if (
      item.type !== "subagent" ||
      (previous?.type === "subagent" &&
        (previous.runId !== item.runId || previous.providerTurnId !== item.providerTurnId))
    ) {
      flush();
    }
    if (item.type === "subagent") batch.push(entry);
  }
  flush();
  return live;
}

/**
 * Mobile's run folds (apps/mobile/src/lib/threadActivity.ts): each settled run's work, progress
 * messages included, folds behind one row placed at its first hidden item. The run's last
 * assistant message stays out as its answer. Running, streaming, interrupted, and failed runs do
 * not fold. Keyed by the anchor item.
 */
function deriveTurnFolds(
  items: ReadonlyArray<VisibleTurnItem>,
  latestRun: ThreadRowsRun | null,
  runlessWorkActive: boolean,
): ReadonlyMap<VisibleTurnItem, TurnFold> {
  const promptIndexByRunId = new Map<string, number>();
  for (const [index, { item }] of items.entries()) {
    if (
      item.type === "user_message" &&
      item.inputIntent !== "steer" &&
      item.inputIntent !== "promoted_queued_to_steer" &&
      item.runId !== null &&
      !promptIndexByRunId.has(item.runId)
    ) {
      promptIndexByRunId.set(item.runId, index);
    }
  }
  interface TurnGroup {
    readonly members: Array<VisibleTurnItem>;
    readonly prompt: VisibleTurnItem | null;
    terminal: VisibleTurnItem | null;
    unfoldable: boolean;
  }
  const groups = new Map<string, TurnGroup>();
  let runlessKey: string | null = null;
  let responseKey: string | null = null;
  let pendingPrompt: VisibleTurnItem | null = null;
  for (const [index, entry] of items.entries()) {
    const item = entry.item;
    if (item.type === "user_message") {
      pendingPrompt = entry;
      runlessKey = item.runId === null ? `runless:${rowKey(entry)}` : null;
      responseKey = item.runId ?? runlessKey;
      continue;
    }
    if (item.type !== "subagent" && cachedRow(entry) === null) continue;
    const ownRunId = item.runId ?? runlessKey;
    if (ownRunId === null) continue;
    // A resumed subagent keeps its original turn's position, so it folds with that turn.
    const runId =
      responseKey !== null && (promptIndexByRunId.get(ownRunId) ?? -1) > index
        ? responseKey
        : ownRunId;
    let group = groups.get(runId);
    if (group === undefined) {
      group = { members: [], prompt: pendingPrompt, terminal: null, unfoldable: false };
      pendingPrompt = null;
      groups.set(runId, group);
    }
    group.members.push(entry);
    if (item.type === "assistant_message") {
      group.terminal = entry;
      if (item.streaming) group.unfoldable = true;
    }
    if (item.type === "run_interrupt_result" || isFailedRootError(item)) group.unfoldable = true;
  }

  const activeRunId = unsettledRunId(latestRun);
  const liveSubagents = liveSubagentItems(items);
  const folds = new Map<VisibleTurnItem, TurnFold>();
  for (const [runId, group] of groups) {
    if (
      group.unfoldable ||
      runId === activeRunId ||
      (runlessWorkActive && runId === runlessKey) ||
      (latestRun?.runId === runId && latestRun.status === "failed")
    ) {
      continue;
    }
    const hidden = new Set(
      group.members.filter(
        (entry) =>
          entry !== group.terminal && !staysVisible(entry.item) && !liveSubagents.has(entry),
      ),
    );
    const anchor = group.members.find((entry) => hidden.has(entry));
    const first = group.members[0];
    const last = group.members.at(-1);
    if (anchor === undefined || first === undefined || last === undefined) continue;
    const latest = latestRun?.runId === runId ? latestRun : null;
    const elapsedMs =
      latest?.startedAt && latest.completedAt
        ? Date.parse(latest.completedAt) - Date.parse(latest.startedAt)
        : Math.max(group.terminal === null ? 0 : itemEnd(group.terminal.item), itemEnd(last.item)) -
          itemStart((group.prompt ?? first).item);
    const duration = Number.isFinite(elapsedMs) ? formatDuration(Math.max(0, elapsedMs)) : null;
    const stopped = latest?.status === "interrupted" || latest?.status === "cancelled";
    folds.set(anchor, {
      runId,
      hidden,
      label: stopped
        ? duration
          ? `You stopped after ${duration}`
          : "You stopped this response"
        : duration
          ? `Worked for ${duration}`
          : "Worked",
    });
  }
  return folds;
}

const NO_EXPANDED_RUNS: ReadonlySet<string> = new Set();

/**
 * The feed rows for a thread's visible turn items. Items the stream did not touch keep their
 * identity, so their rows do too and memoized row components skip re-rendering. Consecutive
 * subagents of one provider turn collapse into one row; keys stay unique even if the projection
 * repeats a source item. A settled turn's work folds behind one row unless its run is expanded.
 */
export function deriveThreadRows(
  items: ReadonlyArray<VisibleTurnItem>,
  options: ThreadRowsOptions = {},
): ReadonlyArray<ThreadRow> {
  const expandedRunIds = options.expandedRunIds ?? NO_EXPANDED_RUNS;
  const folds = deriveTurnFolds(
    items,
    options.latestRun ?? null,
    options.runlessWorkActive ?? false,
  );
  const collapsed = new Set<VisibleTurnItem>();
  for (const fold of folds.values()) {
    if (expandedRunIds.has(fold.runId)) continue;
    for (const entry of fold.hidden) collapsed.add(entry);
  }
  const rows: Array<ThreadRow> = [];
  const seenKeys = new Map<string, number>();
  let group: { key: string; members: Array<SubagentItem> } | null = null;
  const flushGroup = () => {
    if (group === null) return;
    const [first] = group.members;
    if (group.members.length === 1 && first !== undefined) {
      rows.push(toolRow(group.key, first, "Subagent", first.prompt));
    } else {
      rows.push(subagentGroupRow(group.key, group.members));
    }
    group = null;
  };
  const uniqueKey = (key: string) => {
    const count = seenKeys.get(key) ?? 0;
    seenKeys.set(key, count + 1);
    return count === 0 ? key : `${key}#${count}`;
  };
  for (const entry of items) {
    const fold = folds.get(entry);
    if (fold !== undefined) {
      flushGroup();
      rows.push({
        kind: "fold",
        key: uniqueKey(`fold:${fold.runId}`),
        runId: fold.runId,
        label: fold.label,
        expanded: expandedRunIds.has(fold.runId),
      });
    }
    if (collapsed.has(entry)) continue;
    const item = entry.item;
    if (item.type === "subagent") {
      const previous: SubagentItem | undefined = group?.members[group.members.length - 1];
      if (
        group !== null &&
        previous !== undefined &&
        previous.runId === item.runId &&
        previous.providerTurnId === item.providerTurnId
      ) {
        group.members.push(item);
      } else {
        flushGroup();
        group = { key: uniqueKey(rowKey(entry)), members: [item] };
      }
      continue;
    }
    flushGroup();
    const row = cachedRow(entry);
    if (row === null) continue;
    const key = uniqueKey(row.key);
    rows.push(key === row.key ? row : { ...row, key });
  }
  flushGroup();
  return rows;
}
