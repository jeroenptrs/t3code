import {
  DIFF_WALKTHROUGH_OTHER_GROUP_ID,
  ProjectId,
  type DiffWalkthrough,
  type DiffWalkthroughNote,
  type DiffWalkthroughTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDiffWalkthroughSections,
  clampDiffWalkthroughSectionIndex,
  diffWalkthroughStaleNotice,
  firstUnreviewedSectionIndex,
  formatDiffWalkthroughNoteRange,
  formatDiffWalkthroughOrdinal,
  isDiffWalkthroughSectionReviewed,
  pickPullRequestWalkthrough,
  sectionIndexAfterReview,
  unviewedSectionFiles,
} from "./diffWalkthroughView.logic";

const projectId = ProjectId.make("project");

const pullRequestTarget = (headSha: string): DiffWalkthroughTarget => ({
  kind: "pull-request",
  projectId,
  repository: "owner/repo",
  number: 7,
  headSha,
});

const branchTarget = (headSha: string, baseSha = "base000"): DiffWalkthroughTarget => ({
  kind: "branch-range",
  projectId,
  branch: "feature/expiry",
  baseSha,
  headSha,
});

const note = (
  groupId: string,
  path: string,
  start: number,
  summary: string,
  extra: Partial<DiffWalkthroughNote> = {},
): DiffWalkthroughNote => ({
  groupId,
  path,
  side: "new",
  start,
  end: start + 2,
  summary,
  ...extra,
});

const walkthroughFor = (target: DiffWalkthroughTarget): DiffWalkthrough => ({
  target,
  summary: "Moves session expiry to the server.",
  groups: [
    {
      id: "core",
      title: "Expiry rule",
      summary: "Where a session's end is decided.",
      attention: { kind: "risk", note: "Clients that cached the old expiry keep it." },
      files: [
        { path: "src/session.ts", note: "Owns the expiry rule now." },
        { path: "src/gone.ts", note: "Gone from the diff." },
      ],
      questions: ["Why decide expiry on the server?"],
    },
    {
      id: "ui",
      title: "Banner",
      summary: "What the user sees.",
      attention: null,
      files: [{ path: "web/Banner.tsx" }],
      questions: [],
    },
    {
      id: "empty",
      title: "Removed",
      summary: "No longer changed.",
      attention: null,
      files: [{ path: "src/old.ts" }],
      questions: [],
    },
  ],
  notes: [
    note("core", "src/session.ts", 40, "Expiry moves here"),
    note("ui", "web/Banner.tsx", 3, "Banner reads the new field", { body: "Longer **why**." }),
    note("core", "src/session.ts", 10, "Old check removed", { side: "old" }),
    note("core", "src/gone.ts", 1, "On a file the diff no longer touches"),
  ],
  generatedAt: "2026-10-01T00:00:00.000Z",
  author: {},
});

const walkthrough = walkthroughFor(pullRequestTarget("abcdef1234567890"));
const changedPaths = ["web/Banner.tsx", "src/session.ts", "README.md"];

describe("buildDiffWalkthroughSections", () => {
  const { summary, sections } = buildDiffWalkthroughSections(walkthrough, changedPaths);

  it("makes one section per group in reading order, ending with Other", () => {
    expect(summary).toBe("Moves session expiry to the server.");
    expect(sections.map((section) => [section.id, section.files, section.isOther])).toEqual([
      ["core", ["src/session.ts"], false],
      ["ui", ["web/Banner.tsx"], false],
      [DIFF_WALKTHROUGH_OTHER_GROUP_ID, ["README.md"], true],
    ]);
  });

  it("keeps a section's notes in the order written, without notes on ghost files", () => {
    expect(sections[0]?.notes.map((entry) => [entry.key, entry.note.summary])).toEqual([
      ["note:0", "Expiry moves here"],
      ["note:2", "Old check removed"],
    ]);
    expect(sections[1]?.notes.map((entry) => entry.key)).toEqual(["note:1"]);
    expect(sections[2]?.notes).toEqual([]);
  });

  it("carries a group's attention, questions and the notes of files still in it", () => {
    expect(sections[0]?.attention?.kind).toBe("risk");
    expect(sections[0]?.questions).toEqual(["Why decide expiry on the server?"]);
    expect([...(sections[0]?.fileNotes ?? [])]).toEqual([
      ["src/session.ts", "Owns the expiry rule now."],
    ]);
    expect(sections[2]).toMatchObject({ attention: null, questions: [] });
    expect(sections[2]?.fileNotes.size).toBe(0);
  });
});

describe("formatting", () => {
  it("pads the ordinal to the width of the count", () => {
    expect(formatDiffWalkthroughOrdinal(0, 4)).toBe("01 / 04");
    expect(formatDiffWalkthroughOrdinal(11, 120)).toBe("012 / 120");
  });

  it("names a note's file and lines, and marks lines of the old file", () => {
    expect(formatDiffWalkthroughNoteRange(note("core", "src/a.ts", 12, "x"))).toBe(
      "src/a.ts:L12-L14",
    );
    expect(
      formatDiffWalkthroughNoteRange(note("core", "src/a.ts", 5, "x", { end: 5, side: "old" })),
    ).toBe("src/a.ts:L5 (old)");
  });
});

describe("section review", () => {
  const sections = [{ files: ["a.ts", "b.ts"] }, { files: ["c.ts"] }, { files: ["d.ts"] }];
  const viewed = new Set(["a.ts", "c.ts"]);
  const isViewed = (path: string) => viewed.has(path);

  it("marks only the section's unviewed files", () => {
    expect(unviewedSectionFiles(sections[0]!, isViewed)).toEqual(["b.ts"]);
    expect(unviewedSectionFiles(sections[1]!, isViewed)).toEqual([]);
  });

  it("is reviewed once every file in it is viewed", () => {
    expect(isDiffWalkthroughSectionReviewed(sections[0]!, isViewed)).toBe(false);
    expect(isDiffWalkthroughSectionReviewed(sections[1]!, isViewed)).toBe(true);
  });

  it("finds the first section with something left to view", () => {
    expect(firstUnreviewedSectionIndex(sections, isViewed)).toBe(0);
    expect(firstUnreviewedSectionIndex(sections, () => true)).toBeNull();
  });
});

describe("section navigation", () => {
  it("advances after a review and stays on the last section", () => {
    expect(sectionIndexAfterReview(0, 3)).toBe(1);
    expect(sectionIndexAfterReview(2, 3)).toBe(2);
  });

  it("keeps an index inside the sections there are", () => {
    expect(clampDiffWalkthroughSectionIndex(-1, 3)).toBe(0);
    expect(clampDiffWalkthroughSectionIndex(5, 3)).toBe(2);
    expect(clampDiffWalkthroughSectionIndex(4, 0)).toBe(0);
  });
});

describe("diffWalkthroughStaleNotice", () => {
  it("names the short commit a stale walkthrough was written for", () => {
    expect(diffWalkthroughStaleNotice(walkthrough, pullRequestTarget("fedcba"))).toBe(
      "Written for an older commit (abcdef1)",
    );
    expect(
      diffWalkthroughStaleNotice(
        walkthroughFor(branchTarget("1234567890")),
        branchTarget("1234567890", "base111"),
      ),
    ).toBe("Written for an older commit (1234567)");
  });

  it("is null when current or when the live revision is unknown", () => {
    expect(
      diffWalkthroughStaleNotice(walkthrough, pullRequestTarget("abcdef1234567890")),
    ).toBeNull();
    expect(diffWalkthroughStaleNotice(walkthrough, null)).toBeNull();
  });
});

describe("pickPullRequestWalkthrough", () => {
  const branchWalkthrough = walkthroughFor(branchTarget("head123"));

  it("prefers the pull request's own walkthrough, even a stale one", () => {
    const stale = walkthroughFor(pullRequestTarget("older"));
    expect(pickPullRequestWalkthrough(stale, branchWalkthrough, "head123")).toBe(stale);
  });

  it("falls back to the head branch's walkthrough written at the live head", () => {
    expect(pickPullRequestWalkthrough(null, branchWalkthrough, "head123")).toBe(branchWalkthrough);
  });

  it("does not show a branch walkthrough written at another head, or with no head to match", () => {
    expect(pickPullRequestWalkthrough(null, branchWalkthrough, "head456")).toBeNull();
    expect(pickPullRequestWalkthrough(null, branchWalkthrough, null)).toBeNull();
    expect(pickPullRequestWalkthrough(null, null, "head123")).toBeNull();
  });
});
