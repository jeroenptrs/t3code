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

const tool = (item: VisibleTurnItem["item"], name: string, preview: string): ThreadRow => ({
  kind: "tool",
  key: item.id,
  name,
  preview: oneLine(preview),
  status: item.status,
});

function toRow(entry: VisibleTurnItem): ThreadRow | null {
  const item = entry.item;
  switch (item.type) {
    case "user_message":
      return {
        kind: "user",
        key: item.id,
        text: item.text,
        images: imageAttachments(item.attachments),
      };
    case "assistant_message": {
      const images = imageAttachments(item.attachments);
      if (item.text.length === 0 && images.length === 0 && !item.streaming) return null;
      return {
        kind: "assistant",
        key: item.id,
        text: item.text,
        images,
        streaming: item.streaming,
      };
    }
    case "proposed_plan":
      return {
        kind: "assistant",
        key: item.id,
        text: item.markdown,
        images: NO_IMAGES,
        streaming: item.streaming,
      };
    case "command_execution":
      return tool(item, "Run", item.input);
    case "dynamic_tool":
      return tool(item, item.toolName ?? "Tool", previewUnknown(item.input));
    case "file_change": {
      const counts = [
        item.additions === undefined ? null : `+${item.additions}`,
        item.deletions === undefined ? null : `-${item.deletions}`,
      ].filter((part) => part !== null);
      return tool(item, "Edit", [item.fileName, ...counts].join(" "));
    }
    case "file_search":
      return tool(item, "Search files", item.pattern ?? "");
    case "web_search":
      return tool(item, "Web search", (item.patterns ?? []).join(", "));
    case "subagent":
      return tool(item, "Subagent", item.prompt);
    case "todo_list": {
      const done = item.steps.filter((step) => step.status === "completed").length;
      return tool(item, "Todo", `${done}/${item.steps.length} done`);
    }
    case "approval_request":
      return {
        kind: "notice",
        key: item.id,
        text: `Approval ${item.status === "pending" || item.status === "waiting" ? "requested" : item.status}: ${oneLine(item.prompt ?? item.reason ?? item.requestKind)}`,
        tone: "warning",
      };
    case "user_input_request":
      return {
        kind: "notice",
        key: item.id,
        text: `Question: ${oneLine(item.questions.map((question) => question.question).join(" · "))}`,
        tone: "warning",
      };
    case "error":
      return { kind: "notice", key: item.id, text: item.failure.message, tone: "danger" };
    case "system_notice":
    case "run_interrupt_request":
    case "run_interrupt_result":
      return { kind: "notice", key: item.id, text: item.message, tone: "muted" };
    case "notification":
      return { kind: "notice", key: item.id, text: item.summary, tone: "muted" };
    case "compaction":
      return { kind: "notice", key: item.id, text: "Context compacted", tone: "muted" };
    default:
      // Reasoning, checkpoints, handoffs, forks, and items newer than this client stay hidden.
      return null;
  }
}

const rowCache = new WeakMap<VisibleTurnItem, ThreadRow | null>();

/**
 * The feed rows for a thread's visible turn items. Items the stream did not touch keep their
 * identity, so their rows do too and memoized row components skip re-rendering.
 */
export function deriveThreadRows(items: ReadonlyArray<VisibleTurnItem>): ReadonlyArray<ThreadRow> {
  const rows: Array<ThreadRow> = [];
  for (const entry of items) {
    let row = rowCache.get(entry);
    if (row === undefined) {
      row = toRow(entry);
      rowCache.set(entry, row);
    }
    if (row !== null) rows.push(row);
  }
  return rows;
}
