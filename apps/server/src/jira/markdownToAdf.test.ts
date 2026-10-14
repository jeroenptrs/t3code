import { describe, expect, it } from "vite-plus/test";

import { adfToMarkdown } from "./adfToMarkdown.ts";
import { markdownToAdf } from "./markdownToAdf.ts";

const text = (value: string, marks?: unknown[]) => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const content = (markdown: string) => markdownToAdf(markdown).content;

describe("markdownToAdf", () => {
  it.each(["", "   ", "\n\n  \n"])("yields an empty document for %j", (input) => {
    expect(markdownToAdf(input)).toEqual({ type: "doc", version: 1, content: [] });
  });

  it("converts paragraphs and headings", () => {
    expect(content("## Problem\n\nFirst.\n\nSecond.")).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [text("Problem")] },
      paragraph(text("First.")),
      paragraph(text("Second.")),
    ]);
  });

  it("turns line breaks inside a paragraph into hard breaks", () => {
    expect(content("one  \ntwo\nthree\\\nfour")).toEqual([
      paragraph(
        text("one"),
        { type: "hardBreak" },
        text("two"),
        { type: "hardBreak" },
        text("three"),
        { type: "hardBreak" },
        text("four"),
      ),
    ]);
  });

  it("applies inline marks, including nested and combined ones", () => {
    expect(content("**bold** *it* _it2_ ~~gone~~ `code` ***both***")).toEqual([
      paragraph(
        text("bold", [{ type: "strong" }]),
        text(" "),
        text("it", [{ type: "em" }]),
        text(" "),
        text("it2", [{ type: "em" }]),
        text(" "),
        text("gone", [{ type: "strike" }]),
        text(" "),
        text("code", [{ type: "code" }]),
        text(" "),
        text("both", [{ type: "em" }, { type: "strong" }]),
      ),
    ]);
    expect(content("**a *b* c**")).toEqual([
      paragraph(
        text("a ", [{ type: "strong" }]),
        text("b", [{ type: "strong" }, { type: "em" }]),
        text(" c", [{ type: "strong" }]),
      ),
    ]);
  });

  it("leaves unmatched or intraword delimiters literal", () => {
    expect(content("2 * 3 = 6, snake_case_name, **open")).toEqual([
      paragraph(text("2 * 3 = 6, snake_case_name, **open")),
    ]);
  });

  it("keeps markdown syntax inside code spans and honours backslash escapes", () => {
    expect(content("`a **b** [c](d)` and \\*not em\\*")).toEqual([
      paragraph(text("a **b** [c](d)", [{ type: "code" }]), text(" and *not em*")),
    ]);
  });

  it("does not combine code with other marks, which ADF forbids", () => {
    expect(content("**`x`**")).toEqual([paragraph(text("x", [{ type: "code" }]))]);
  });

  it("converts links, bare URLs, autolinks and images without losing text", () => {
    const link = (href: string) => [{ type: "link", attrs: { href } }];
    expect(
      content(
        "[docs](https://example.com/a%20b) see https://example.com/x. <https://example.com/card> ![logo](https://example.com/l.png)",
      ),
    ).toEqual([
      paragraph(
        text("docs", link("https://example.com/a%20b")),
        text(" see "),
        text("https://example.com/x", link("https://example.com/x")),
        text(". "),
        { type: "inlineCard", attrs: { url: "https://example.com/card" } },
        text(" "),
        text("logo", link("https://example.com/l.png")),
      ),
    ]);
    expect(content("**[bold link](https://example.com)**")).toEqual([
      paragraph(text("bold link", [...link("https://example.com"), { type: "strong" }])),
    ]);
  });

  it("keeps the label and destination of links Jira would reject", () => {
    expect(content("[readme](./README.md)")).toEqual([paragraph(text("readme (./README.md)"))]);
  });

  it("converts bullet and ordered lists with nesting", () => {
    expect(content("- a\n  1. b\n  2. c\n     - d\n- e")).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph(text("a")),
              {
                type: "orderedList",
                content: [
                  { type: "listItem", content: [paragraph(text("b"))] },
                  {
                    type: "listItem",
                    content: [
                      paragraph(text("c")),
                      {
                        type: "bulletList",
                        content: [{ type: "listItem", content: [paragraph(text("d"))] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { type: "listItem", content: [paragraph(text("e"))] },
        ],
      },
    ]);
  });

  it("keeps the start number of ordered lists and splits lists by kind", () => {
    expect(content("3. x\n4. y\n\n- z")).toEqual([
      {
        type: "orderedList",
        attrs: { order: 3 },
        content: [
          { type: "listItem", content: [paragraph(text("x"))] },
          { type: "listItem", content: [paragraph(text("y"))] },
        ],
      },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("z"))] }] },
    ]);
  });

  it("lets only an ordered list starting at 1 interrupt a paragraph", () => {
    expect(content("Shipped the fix in\n2024. Follow-up pending.")).toEqual([
      paragraph(
        text("Shipped the fix in"),
        { type: "hardBreak" },
        text("2024. Follow-up pending."),
      ),
    ]);
    expect(content("Steps:\n1. build")).toEqual([
      paragraph(text("Steps:")),
      {
        type: "orderedList",
        content: [{ type: "listItem", content: [paragraph(text("build"))] }],
      },
    ]);
    expect(content("1. a\n2. b")[0]).toMatchObject({
      type: "orderedList",
      content: [{ type: "listItem" }, { type: "listItem" }],
    });
  });

  it("keeps loose list items and continuation paragraphs in one item", () => {
    expect(content("- a\n\n  more\n\n- b")).toEqual([
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(text("a")), paragraph(text("more"))] },
          { type: "listItem", content: [paragraph(text("b"))] },
        ],
      },
    ]);
  });

  it("converts fenced code blocks with language, widened fences and no closing fence", () => {
    expect(content("```ts\nconst a = 1;\n\nconst b = 2;\n```")).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [text("const a = 1;\n\nconst b = 2;")],
      },
    ]);
    expect(content("````\na\n```\nb\n````")).toEqual([
      { type: "codeBlock", content: [text("a\n```\nb")] },
    ]);
    expect(content("```\n# still code")).toEqual([
      { type: "codeBlock", content: [text("# still code")] },
    ]);
    expect(content("```\n```")).toEqual([{ type: "codeBlock" }]);
  });

  it("converts blockquotes, including lazy lines and nested blocks", () => {
    expect(content("> quoted\nlazy\n>\n> - item")).toEqual([
      {
        type: "blockquote",
        content: [
          paragraph(text("quoted"), { type: "hardBreak" }, text("lazy")),
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [paragraph(text("item"))] }],
          },
        ],
      },
    ]);
  });

  it("falls back to paragraphs for blocks ADF does not allow in quotes and list items", () => {
    expect(content("> # Title\n>\n> ---\n>\n> | a | b |\n> | - | - |\n> | 1 | 2 |")).toEqual([
      {
        type: "blockquote",
        content: [paragraph(text("Title")), paragraph(text("a | b")), paragraph(text("1 | 2"))],
      },
    ]);
    expect(content("- ## Title\n  body")).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [paragraph(text("Title")), paragraph(text("body"))],
          },
        ],
      },
    ]);
  });

  it("converts horizontal rules without mistaking them for lists", () => {
    expect(content("a\n\n---\n\n* * *\n\nb")).toEqual([
      paragraph(text("a")),
      { type: "rule" },
      { type: "rule" },
      paragraph(text("b")),
    ]);
  });

  it("converts tables with a header row, escaped pipes and ragged rows", () => {
    const cell = (type: string, ...inline: unknown[]) => ({
      type,
      content: [paragraph(...inline)],
    });
    expect(content("| Name | Value |\n| --- | :-: |\n| a\\|b | `x` |\n| only |")).toEqual([
      {
        type: "table",
        attrs: { isNumberColumnEnabled: false, layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [cell("tableHeader", text("Name")), cell("tableHeader", text("Value"))],
          },
          {
            type: "tableRow",
            content: [
              cell("tableCell", text("a|b")),
              cell("tableCell", text("x", [{ type: "code" }])),
            ],
          },
          { type: "tableRow", content: [cell("tableCell", text("only")), cell("tableCell")] },
        ],
      },
    ]);
  });

  it("does not treat a lone pipe line as a table", () => {
    expect(content("a | b\nnot a delimiter row")).toEqual([
      paragraph(text("a | b"), { type: "hardBreak" }, text("not a delimiter row")),
    ]);
  });

  it("keeps unsupported syntax as plain text", () => {
    expect(content("- [ ] todo\n\n<div>html</div>\n\n[ref][1]")).toEqual([
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph(text("[ ] todo"))] }],
      },
      paragraph(text("<div>html</div>")),
      paragraph(text("[ref][1]")),
    ]);
  });

  it("accepts CRLF input and never emits empty text nodes", () => {
    expect(content("a\r\n\r\n**b**\r\n")).toEqual([
      paragraph(text("a")),
      paragraph(text("b", [{ type: "strong" }])),
    ]);
  });

  it.each(["**", "[", "[](", "`", "![", "<", "| a |\n|", "> ", "- ", "\\", "```", "1.", "~~~~"])(
    "never throws and never emits an empty text node for %j",
    (input) => {
      const json = JSON.stringify(markdownToAdf(input));
      expect(json).not.toContain('"text":""');
    },
  );
});

describe("markdownToAdf round trip", () => {
  const roundTrip = (markdown: string) => adfToMarkdown(markdownToAdf(markdown));

  it.each([
    ["headings and paragraphs", "# Title\n\n### Sub\n\nSome text."],
    ["marks", "**bold** and *em* and ~~strike~~ and `code`"],
    ["links", "see [the docs](https://example.com/a%20b) and <https://example.com/x>."],
    ["hard breaks", "first  \nsecond"],
    ["bullet list", "- one\n- **two**\n- *three*"],
    ["nested lists", "- a\n  3. b\n     - c\n  4. d\n- e"],
    ["code block with language", "```ts\nconst a = 1;\n\nconst b = 2;\n```"],
    ["code block with backticks", "````\na\n\n```\nb\n````"],
    ["blockquote", "> quoted\n>\n> - item\n> - other"],
    ["rule", "before\n\n---\n\nafter"],
    ["table", "| Name | Value |\n| --- | --- |\n| a\\|b | 2 |\n| `c` | **d** |"],
    ["escaped line starts", "\\# not a heading\n\n1\\. not a list\n\na - b > c"],
    ["inline code with backticks", "``a`b``"],
    [
      "a realistic description",
      [
        "## Problem",
        "",
        "Login fails on `staging`  ",
        "See [the docs](https://example.com/a).",
        "",
        "1. Open the page",
        "2. Click **Sign in**",
        "   - expect a redirect",
        "",
        "> Careful",
        "",
        "```sh",
        "pnpm test",
        "```",
        "",
        "---",
        "",
        "Done.",
      ].join("\n"),
    ],
  ])("is the inverse of adfToMarkdown for %s", (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });
});
