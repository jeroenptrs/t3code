import { assert, describe, it } from "@effect/vitest";
import type { DiffWalkthroughNote } from "@t3tools/contracts";

import { parseDiffChange } from "../review/diffChange.ts";
import { holdNotesToChange } from "./DiffWalkthroughWriter.ts";

// a.ts: lines 10-12 added after old line 9, old line 20 replaced by new 23-24.
// gone.ts deleted (old 1-3). new.ts renamed from old.ts with line 5 changed.
const patch = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -9,0 +10,3 @@",
  "+one",
  "+two",
  "+three",
  "@@ -20 +23,2 @@",
  "-old",
  "+new",
  "+newer",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
  "-a",
  "-b",
  "-c",
  "diff --git a/old.ts b/new.ts",
  "similarity index 90%",
  "rename from old.ts",
  "rename to new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -5 +5 @@",
  "-before",
  "+after",
  "",
].join("\n");

const change = parseDiffChange("a.ts\0gone.ts\0new.ts\0", patch);

const note = (
  path: string,
  side: "new" | "old",
  start: number,
  end: number,
): DiffWalkthroughNote => ({ groupId: "core", path, side, start, end, summary: `${path}` });

describe("holdNotesToChange", () => {
  it("keeps notes on changed lines, narrows ones reaching past them, and drops the rest", () => {
    const held = holdNotesToChange(
      [
        note("a.ts", "new", 10, 12),
        // Starts on context before the first hunk and ends past the second: narrowed to both.
        note("a.ts", "new", 5, 30),
        // Unchanged context between the hunks.
        note("a.ts", "new", 14, 20),
        note("a.ts", "old", 20, 20),
        // Old line 10 is unchanged; new line 10 is not, but the side decides.
        note("a.ts", "old", 10, 12),
        note("untouched.ts", "new", 1, 1),
      ],
      change,
      new Set(),
    );
    assert.deepStrictEqual(
      held.notes.map(({ path, side, start, end }) => ({ path, side, start, end })),
      [
        { path: "a.ts", side: "new", start: 10, end: 12 },
        { path: "a.ts", side: "new", start: 10, end: 24 },
        { path: "a.ts", side: "old", start: 20, end: 20 },
      ],
    );
    assert.deepStrictEqual(held.narrowed, [
      { path: "a.ts", side: "new", from: { start: 5, end: 30 }, to: { start: 10, end: 24 } },
    ]);
    assert.deepStrictEqual(held.dropped, [
      { path: "a.ts", side: "new", start: 14, end: 20 },
      { path: "a.ts", side: "old", start: 10, end: 12 },
      { path: "untouched.ts", side: "new", start: 1, end: 1 },
    ]);
  });

  it("holds a deleted file's notes to its old side and a renamed file's to its new path", () => {
    const held = holdNotesToChange(
      [
        note("gone.ts", "old", 2, 9),
        note("gone.ts", "new", 1, 3),
        note("new.ts", "old", 5, 5),
        note("new.ts", "new", 4, 6),
        // A renamed file is named by its new path, so its old name is not in the change.
        note("old.ts", "old", 5, 5),
      ],
      change,
      new Set(),
    );
    assert.deepStrictEqual(
      held.notes.map(({ path, side, start, end }) => ({ path, side, start, end })),
      [
        { path: "gone.ts", side: "old", start: 2, end: 3 },
        { path: "new.ts", side: "old", start: 5, end: 5 },
        { path: "new.ts", side: "new", start: 5, end: 5 },
      ],
    );
    assert.deepStrictEqual(
      held.dropped.map((anchor) => `${anchor.path}:${anchor.side}`),
      ["gone.ts:new", "old.ts:old"],
    );
  });

  it("leaves notes on a withheld file as written", () => {
    const withheld = note("assets/logo.png", "new", 1, 400);
    const held = holdNotesToChange([withheld], change, new Set(["assets/logo.png"]));
    assert.deepStrictEqual(held.notes, [withheld]);
    assert.deepStrictEqual(held.dropped, []);
    assert.deepStrictEqual(held.narrowed, []);
  });
});
