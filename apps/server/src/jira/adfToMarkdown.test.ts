import { describe, expect, it } from "vite-plus/test";

import { adfToMarkdown } from "./adfToMarkdown.ts";

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, marks });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });

describe("adfToMarkdown", () => {
  it("renders a realistic description", () => {
    const markdown = adfToMarkdown(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("Problem")] },
        paragraph(
          text("Login fails for "),
          { type: "mention", attrs: { id: "1", text: "@Jane Doe" } },
          text(" on "),
          text("staging", [{ type: "code" }]),
          { type: "hardBreak" },
          text("See "),
          text("the docs", [{ type: "link", attrs: { href: "https://example.com/a b" } }]),
          text(" and "),
          { type: "inlineCard", attrs: { url: "https://example.com/x" } },
          text(". Due "),
          { type: "date", attrs: { timestamp: "1582152559000" } },
          text(" "),
          { type: "status", attrs: { text: "In Progress", color: "blue" } },
          text(" "),
          { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } },
        ),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph(text("one", [{ type: "strong" }]))] },
            { type: "listItem", content: [paragraph(text("two", [{ type: "em" }]))] },
          ],
        },
        {
          type: "panel",
          attrs: { panelType: "warning" },
          content: [paragraph(text("Careful"))],
        },
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;")] },
        { type: "rule" },
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "DONE" }, content: [text("done")] },
            { type: "taskItem", attrs: { state: "TODO" }, content: [text("todo")] },
          ],
        },
        {
          type: "mediaSingle",
          content: [{ type: "media", attrs: { id: "x", type: "file" } }],
        },
        {
          type: "expand",
          attrs: { title: "Details" },
          content: [paragraph(text("hidden"))],
        },
      ),
    );
    expect(markdown).toBe(
      [
        "## Problem",
        "",
        "Login fails for @Jane Doe on `staging`  ",
        "See [the docs](https://example.com/a%20b) and <https://example.com/x>. Due 2020-02-19 `In Progress` 😄",
        "",
        "- **one**",
        "- *two*",
        "",
        "> **Warning:**",
        ">",
        "> Careful",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "",
        "---",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "[attachment]",
        "",
        "**Details**",
        "",
        "hidden",
      ].join("\n"),
    );
  });

  it("indents nested lists", () => {
    const item = (label: string, ...nested: unknown[]) => ({
      type: "listItem",
      content: [paragraph(text(label)), ...nested],
    });
    expect(
      adfToMarkdown(
        doc({
          type: "bulletList",
          content: [
            item("a", {
              type: "orderedList",
              attrs: { order: 3 },
              content: [item("b", { type: "bulletList", content: [item("c")] }), item("d")],
            }),
            item("e"),
          ],
        }),
      ),
    ).toBe(["- a", "  3. b", "     - c", "  4. d", "- e"].join("\n"));
  });

  it("keeps blank lines inside code blocks and widens the fence around backticks", () => {
    expect(adfToMarkdown(doc({ type: "codeBlock", content: [text("a\n\n```\nb")] }))).toBe(
      "````\na\n\n```\nb\n````",
    );
  });

  it("applies mark combinations without swallowing whitespace", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            text("bold ", [{ type: "strong" }]),
            text("x", [{ type: "strike" }]),
            text("u", [{ type: "underline" }]),
          ),
        ),
      ),
    ).toBe("**bold** ~~x~~u");
  });

  it("renders tables with the first row as header and escapes pipes", () => {
    const cell = (type: string, value: string) => ({
      type,
      content: [paragraph(text(value))],
    });
    expect(
      adfToMarkdown(
        doc({
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [cell("tableHeader", "Name"), cell("tableHeader", "Value")],
            },
            { type: "tableRow", content: [cell("tableCell", "a|b"), cell("tableCell", "2")] },
          ],
        }),
      ),
    ).toBe(["| Name | Value |", "| --- | --- |", "| a\\|b | 2 |"].join("\n"));
  });

  it("falls back for mentions without text and skips placeholders", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            { type: "mention", attrs: { id: "1" } },
            { type: "placeholder", attrs: { text: "x" } },
          ),
        ),
      ),
    ).toBe("@user");
  });

  it("escapes line-start syntax in prose only", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(text("# not a heading")),
          paragraph(text("1. not a list")),
          paragraph(text("a - b > c")),
        ),
      ),
    ).toBe("\\# not a heading\n\n1\\. not a list\n\na - b > c");
  });

  it("renders unknown nodes by their children", () => {
    expect(
      adfToMarkdown(
        doc({ type: "futureNode", content: [paragraph(text("kept"))] }, { type: "other" }),
      ),
    ).toBe("kept");
  });

  it.each([null, undefined, "text", 42, [], {}, { type: "doc" }, { type: "doc", content: "nope" }])(
    "returns an empty string for %j",
    (input) => {
      expect(adfToMarkdown(input)).toBe("");
    },
  );
});
