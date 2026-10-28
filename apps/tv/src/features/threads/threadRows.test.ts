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
