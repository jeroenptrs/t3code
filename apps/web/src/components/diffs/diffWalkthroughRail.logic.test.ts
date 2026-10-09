import {
  DIFF_WALKTHROUGH_OTHER_GROUP_ID,
  ProjectId,
  type DiffWalkthrough,
  type DiffWalkthroughNote,
  type DiffWalkthroughTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeDiffWalkthroughEntryKey,
  buildDiffWalkthroughRail,
  diffWalkthroughGroupProgress,
  diffWalkthroughNotesByPath,
  diffWalkthroughStaleNotice,
  lastIndexAtOrAbove,
} from "./diffWalkthroughRail.logic";

const target = (headSha: string): DiffWalkthroughTarget => ({
  kind: "pull-request",
  projectId: ProjectId.make("project"),
  repository: "owner/repo",
  number: 7,
  headSha,
});

const note = (
  groupId: string,
  path: string,
  startLine: number,
  summary: string,
  extra: Partial<DiffWalkthroughNote> = {},
): DiffWalkthroughNote => ({
  groupId,
  path,
  side: "additions",
  startLine,
  endLine: startLine + 2,
  summary,
  ...extra,
});

const walkthrough: DiffWalkthrough = {
  target: target("abcdef1234567890"),
  summary: "Moves session expiry to the server.",
  groups: [
    {
      id: "core",
      title: "Expiry rule",
      summary: "Where a session's end is decided.",
      files: ["src/session.ts", "src/gone.ts"],
    },
    { id: "ui", title: "Banner", summary: "What the user sees.", files: ["web/Banner.tsx"] },
    { id: "empty", title: "Removed", summary: "No longer changed.", files: ["src/old.ts"] },
  ],
  notes: [
    note("core", "src/session.ts", 40, "Expiry moves here"),
    note("ui", "web/Banner.tsx", 3, "Banner reads the new field", { body: "Longer **why**." }),
    note("core", "src/session.ts", 10, "Old check removed", { side: "deletions" }),
    note("core", "src/gone.ts", 1, "On a file the diff no longer touches"),
  ],
  generatedAt: "2026-10-01T00:00:00.000Z",
  author: {},
};

const changedPaths = ["web/Banner.tsx", "src/session.ts", "README.md"];

describe("buildDiffWalkthroughRail", () => {
  const model = buildDiffWalkthroughRail(walkthrough, changedPaths);

  it("numbers groups in reading order, drops emptied ones and ends with Other", () => {
    expect(model.summary).toBe("Moves session expiry to the server.");
    expect(model.groups.map((group) => [group.id, group.ordinal])).toEqual([
      ["core", 1],
      ["ui", 2],
      [DIFF_WALKTHROUGH_OTHER_GROUP_ID, null],
    ]);
    expect(model.groups.at(-1)?.files.map((file) => file.path)).toEqual(["README.md"]);
  });

  it("keeps each file's notes in the walkthrough's order and drops ghost files", () => {
    const core = model.groups[0]!;
    expect(core.files.map((file) => file.path)).toEqual(["src/session.ts"]);
    expect(core.files[0]!.notes.map((entry) => entry.note.summary)).toEqual([
      "Expiry moves here",
      "Old check removed",
    ]);
    expect(model.groups.at(-1)?.files[0]!.notes).toEqual([]);
  });

  it("gives files and notes keys that survive a rebuild", () => {
    const again = buildDiffWalkthroughRail(walkthrough, changedPaths);
    const keys = (rail: typeof model) =>
      rail.groups.flatMap((group) =>
        group.files.flatMap((file) => [file.key, ...file.notes.map((entry) => entry.key)]),
      );
    expect(keys(again)).toEqual(keys(model));
    expect(new Set(keys(model)).size).toBe(keys(model).length);
  });
});

describe("diffWalkthroughGroupProgress", () => {
  it("counts the group's viewed files", () => {
    const [core, ui] = buildDiffWalkthroughRail(walkthrough, changedPaths).groups;
    const viewed = new Set(["src/session.ts"]);
    const isViewed = (path: string) => viewed.has(path);
    expect(diffWalkthroughGroupProgress(core!, isViewed)).toEqual({ viewed: 1, total: 1 });
    expect(diffWalkthroughGroupProgress(ui!, isViewed)).toEqual({ viewed: 0, total: 1 });
  });
});

describe("lastIndexAtOrAbove", () => {
  const tops = [0, 100, 250, 600];
  const topAt = (index: number) => tops[index];

  it("finds the last position the probe has reached", () => {
    expect(lastIndexAtOrAbove(tops.length, topAt, 0)).toBe(0);
    expect(lastIndexAtOrAbove(tops.length, topAt, 249)).toBe(1);
    expect(lastIndexAtOrAbove(tops.length, topAt, 250)).toBe(2);
    expect(lastIndexAtOrAbove(tops.length, topAt, 10_000)).toBe(3);
  });

  it("is -1 above the first position and for an empty list", () => {
    expect(lastIndexAtOrAbove(tops.length, (index) => (tops[index] ?? 0) + 50, 10)).toBe(-1);
    expect(lastIndexAtOrAbove(0, topAt, 10)).toBe(-1);
  });
});

describe("activeDiffWalkthroughEntryKey", () => {
  const notesByPath = diffWalkthroughNotesByPath(walkthrough);
  // Notes sit where their first line is; the deletions note is higher on screen than the first.
  const tops = new Map([
    ["Expiry moves here", 400],
    ["Old check removed", 120],
  ]);
  const noteTop = (candidate: DiffWalkthroughNote) => tops.get(candidate.summary);

  it("is the file until the reader reaches its first note", () => {
    expect(
      activeDiffWalkthroughEntryKey(notesByPath, { path: "src/session.ts", probe: 50, noteTop }),
    ).toBe("file:src/session.ts");
  });

  it("is the lowest note the reader has passed, by position rather than list order", () => {
    expect(
      activeDiffWalkthroughEntryKey(notesByPath, { path: "src/session.ts", probe: 200, noteTop }),
    ).toBe("note:2");
    expect(
      activeDiffWalkthroughEntryKey(notesByPath, { path: "src/session.ts", probe: 450, noteTop }),
    ).toBe("note:0");
  });

  it("falls back to the file when no note can be placed, and to nothing with no file", () => {
    expect(
      activeDiffWalkthroughEntryKey(notesByPath, {
        path: "src/session.ts",
        probe: 450,
        noteTop: () => undefined,
      }),
    ).toBe("file:src/session.ts");
    expect(
      activeDiffWalkthroughEntryKey(notesByPath, { path: "README.md", probe: 450, noteTop }),
    ).toBe("file:README.md");
    expect(activeDiffWalkthroughEntryKey(notesByPath, null)).toBeNull();
  });
});

describe("diffWalkthroughStaleNotice", () => {
  it("names the short commit a stale walkthrough was written for", () => {
    expect(diffWalkthroughStaleNotice(walkthrough, target("fedcba"))).toBe(
      "Out of date: written for abcdef1",
    );
  });

  it("is null when current or when the live revision is unknown", () => {
    expect(diffWalkthroughStaleNotice(walkthrough, target("abcdef1234567890"))).toBeNull();
    expect(diffWalkthroughStaleNotice(walkthrough, null)).toBeNull();
  });
});
