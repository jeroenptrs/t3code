import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadRows } from "./threadRows";

type Items = Parameters<typeof deriveThreadRows>[0];

function userMessage(attachments: ReadonlyArray<Record<string, unknown>>): Items[number] {
  return {
    item: {
      id: "item-1",
      type: "user_message",
      text: "",
      attachments,
    },
  } as unknown as Items[number];
}

describe("deriveThreadRows", () => {
  it("keeps image attachments on a user row, by MIME type, and drops other files", () => {
    const [row] = deriveThreadRows([
      userMessage([
        { type: "image", id: "a", name: "shot.png", mimeType: "image/png", sizeBytes: 1 },
        { type: "file", id: "b", name: "notes.txt", mimeType: "text/plain", sizeBytes: 1 },
        { type: "file", id: "c", name: "photo.JPG", mimeType: "IMAGE/JPEG", sizeBytes: 1 },
      ]),
    ]);
    expect(row).toMatchObject({
      kind: "user",
      images: [
        { id: "a", name: "shot.png", mimeType: "image/png" },
        { id: "c", name: "photo.JPG", mimeType: "IMAGE/JPEG" },
      ],
    });
  });

  it("shows an assistant message that carries only an image", () => {
    const rows = deriveThreadRows([
      {
        item: {
          id: "item-2",
          type: "assistant_message",
          text: "",
          streaming: false,
          attachments: [
            { type: "image", id: "d", name: "chart.png", mimeType: "image/png", sizeBytes: 1 },
          ],
        },
      } as unknown as Items[number],
    ]);
    expect(rows).toHaveLength(1);
  });

  it("gives every row a unique key when a fork repeats its parent's item ids", () => {
    const message = (sourceThreadId: string, id: string, text: string) =>
      ({
        sourceThreadId,
        sourceItemId: id,
        item: { id, type: "user_message", text, attachments: [] },
      }) as unknown as Items[number];
    const items = [
      message("parent", "item-1", "inherited"),
      message("fork", "item-1", "local"),
      message("fork", "item-1", "repeated"),
    ];
    const keys = deriveThreadRows(items).map((row) => row.key);
    expect(new Set(keys).size).toBe(3);
    expect(deriveThreadRows(items).map((row) => row.key)).toEqual(keys);
  });

  it("groups consecutive subagents of one provider turn into one row", () => {
    const subagent = (id: string, status: string) =>
      ({
        sourceThreadId: "thread",
        sourceItemId: id,
        item: {
          id,
          type: "subagent",
          runId: "run-1",
          providerTurnId: "turn-1",
          status,
          prompt: id,
        },
      }) as unknown as Items[number];
    const rows = deriveThreadRows([
      subagent("a", "running"),
      subagent("b", "completed"),
      subagent("c", "running"),
    ]);
    expect(rows).toEqual([
      {
        kind: "subagents",
        key: "thread:a",
        label: "Kicked off 3 subagents",
        statusSummary: "2 working · 1 done",
        active: true,
        failed: false,
      },
    ]);
  });
});

describe("deriveThreadRows turn folds", () => {
  let ordinal = 0;
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-06-20T00:00:${String(second).padStart(2, "0")}Z`);
  const entry = (
    id: string,
    second: number,
    fields: Record<string, unknown>,
    endSecond = second,
  ): Items[number] =>
    ({
      sourceThreadId: "thread",
      sourceItemId: id,
      item: {
        id,
        runId: "run-1",
        parentItemId: null,
        providerTurnId: null,
        ordinal: ordinal++,
        status: "completed",
        startedAt: at(second),
        completedAt: at(endSecond),
        updatedAt: at(endSecond),
        ...fields,
      },
    }) as unknown as Items[number];
  const user = (id: string, second: number, runId = "run-1") =>
    entry(id, second, {
      type: "user_message",
      text: id,
      attachments: [],
      inputIntent: "turn_start",
      runId,
    });
  const assistant = (id: string, second: number, runId = "run-1") =>
    entry(id, second, {
      type: "assistant_message",
      text: id,
      attachments: [],
      streaming: false,
      runId,
    });
  const thought = (id: string, second: number) =>
    entry(id, second, { type: "reasoning", text: `thinking ${id}`, streaming: false });
  const command = (id: string, second: number) =>
    entry(id, second, { type: "command_execution", input: `ls ${id}` });
  const settledRun = {
    runId: "run-1",
    status: "completed",
    startedAt: "2026-06-20T00:00:00.000Z",
    completedAt: "2026-06-20T00:02:05.000Z",
  };
  const shape = (rows: ReturnType<typeof deriveThreadRows>) =>
    rows.map((row) =>
      row.kind === "fold" ? `fold:${row.label}` : `${row.kind}:${row.key.split(":")[1]}`,
    );
  const turn = [
    user("prompt", 0),
    thought("think", 1),
    assistant("progress", 2),
    command("ls", 3),
    assistant("answer", 4),
  ];

  it("folds a settled turn's reasoning, tools, and progress behind its run's duration", () => {
    expect(shape(deriveThreadRows(turn, { latestRun: settledRun }))).toEqual([
      "user:prompt",
      "fold:Worked for 2m 5s",
      "assistant:answer",
    ]);
  });

  it("shows progress messages between the work they split once the fold is open", () => {
    const rows = deriveThreadRows(turn, {
      latestRun: settledRun,
      expandedRunIds: new Set(["run-1"]),
    });
    expect(shape(rows)).toEqual([
      "user:prompt",
      "fold:Worked for 2m 5s",
      "tool:think",
      "assistant:progress",
      "tool:ls",
      "assistant:answer",
    ]);
    expect(rows[1]).toMatchObject({ kind: "fold", runId: "run-1", expanded: true });
  });

  it("keeps a running turn's work live", () => {
    const running = { ...settledRun, status: "running", completedAt: null };
    expect(shape(deriveThreadRows(turn, { latestRun: running }))).toEqual([
      "user:prompt",
      "tool:think",
      "assistant:progress",
      "tool:ls",
      "assistant:answer",
    ]);
  });

  it("does not fold while the answer is still streaming", () => {
    const streaming = [
      ...turn.slice(0, -1),
      entry("answer", 4, {
        type: "assistant_message",
        text: "an",
        attachments: [],
        streaming: true,
      }),
    ];
    expect(deriveThreadRows(streaming).some((row) => row.kind === "fold")).toBe(false);
  });

  it("times an older turn from its prompt to its answer", () => {
    const rows = deriveThreadRows(
      [
        user("first", 0, "run-0"),
        entry("first-ls", 2, { type: "command_execution", input: "ls", runId: "run-0" }),
        assistant("first-answer", 8, "run-0"),
        ...turn.map((item) => item),
      ],
      { latestRun: settledRun },
    );
    expect(shape(rows).slice(0, 3)).toEqual([
      "user:first",
      "fold:Worked for 8.0s",
      "assistant:first-answer",
    ]);
  });

  it("names a turn the user stopped", () => {
    const rows = deriveThreadRows(turn, { latestRun: { ...settledRun, status: "interrupted" } });
    expect(rows[1]).toMatchObject({ kind: "fold", label: "You stopped after 2m 5s" });
  });

  it("leaves a failed turn unfolded", () => {
    const failed = [
      ...turn,
      entry("boom", 5, {
        type: "error",
        status: "failed",
        failure: { message: "boom" },
      }),
    ];
    expect(
      deriveThreadRows(failed, { latestRun: settledRun }).some((row) => row.kind === "fold"),
    ).toBe(false);
  });
});
