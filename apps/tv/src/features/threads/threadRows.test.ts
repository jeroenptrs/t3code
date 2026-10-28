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
});
