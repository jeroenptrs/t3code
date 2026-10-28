import {
  subagentGroupSummary,
  summarizeSubagentStatuses,
} from "@t3tools/client-runtime/state/subagent-display";
import type { ChatAttachment, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

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
    };

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
    default:
      // Reasoning, checkpoints, handoffs, forks, and items newer than this client stay hidden.
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

/**
 * The feed rows for a thread's visible turn items. Items the stream did not touch keep their
 * identity, so their rows do too and memoized row components skip re-rendering. Consecutive
 * subagents of one provider turn collapse into one row; keys stay unique even if the projection
 * repeats a source item.
 */
export function deriveThreadRows(items: ReadonlyArray<VisibleTurnItem>): ReadonlyArray<ThreadRow> {
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
    let row = rowCache.get(entry);
    if (row === undefined) {
      row = toRow(entry);
      rowCache.set(entry, row);
    }
    if (row === null) continue;
    const key = uniqueKey(row.key);
    rows.push(key === row.key ? row : { ...row, key });
  }
  flushGroup();
  return rows;
}
