import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DIFF_WALKTHROUGH_OTHER_GROUP_ID,
  DiffWalkthrough,
  DiffWalkthroughTarget,
  diffWalkthroughTargetKey,
  groupDiffWalkthroughFiles,
  isDiffWalkthroughStale,
} from "./diffWalkthrough.ts";

const decodeWalkthrough = Schema.decodeUnknownSync(DiffWalkthrough);
const decodeTarget = Schema.decodeUnknownSync(DiffWalkthroughTarget);

const PR_TARGET = {
  kind: "pull-request",
  projectId: "project-1",
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 42,
  headSha: "abc123",
} as const;

const WALKTHROUGH = {
  target: PR_TARGET,
  summary: "Adds a walkthrough rail.",
  groups: [
    {
      id: "contract",
      title: "Contract",
      summary: "The shape agents write.",
      files: ["packages/contracts/src/diffWalkthrough.ts"],
    },
    {
      id: "ui",
      title: "Rail",
      summary: "Where reviewers read it.",
      files: ["apps/web/src/Rail.tsx", "apps/web/src/Rail.css"],
    },
  ],
  notes: [
    {
      groupId: "contract",
      path: "packages/contracts/src/diffWalkthrough.ts",
      side: "additions",
      startLine: 10,
      endLine: 20,
      summary: "Targets carry their revision.",
      body: "Only `headSha` moves.",
    },
    {
      groupId: "ui",
      path: "apps/web/src/Rail.tsx",
      side: "deletions",
      startLine: 5,
      endLine: 5,
      summary: "Old inline cards go.",
    },
  ],
  generatedAt: "2026-10-09T12:00:00.000Z",
  author: { provider: "claudeAgent", model: "claude-opus-5-5" },
};

describe("DiffWalkthrough", () => {
  it("decodes a consistent walkthrough", () => {
    const decoded = decodeWalkthrough(WALKTHROUGH);
    expect(decoded.groups.map((group) => group.id)).toEqual(["contract", "ui"]);
    expect(decoded.notes).toHaveLength(2);
  });

  it("rejects a group id used twice", () => {
    expect(() =>
      decodeWalkthrough({
        ...WALKTHROUGH,
        groups: [WALKTHROUGH.groups[0], { ...WALKTHROUGH.groups[1], id: "contract" }],
        notes: [],
      }),
    ).toThrow(/used more than once/);
  });

  it("rejects a note naming no group", () => {
    expect(() =>
      decodeWalkthrough({
        ...WALKTHROUGH,
        notes: [{ ...WALKTHROUGH.notes[0], groupId: "missing" }],
      }),
    ).toThrow(/unknown group "missing"/);
  });

  it("rejects a note on a file outside its group", () => {
    expect(() =>
      decodeWalkthrough({
        ...WALKTHROUGH,
        notes: [{ ...WALKTHROUGH.notes[0], groupId: "ui" }],
      }),
    ).toThrow(/is not a file of group "ui"/);
  });

  it("rejects a file placed in two groups", () => {
    expect(() =>
      decodeWalkthrough({
        ...WALKTHROUGH,
        groups: [
          WALKTHROUGH.groups[0],
          { ...WALKTHROUGH.groups[1], files: ["packages/contracts/src/diffWalkthrough.ts"] },
        ],
        notes: [],
      }),
    ).toThrow(/is in both group "contract" and group "ui"/);
  });

  it("rejects a multi-line note summary", () => {
    expect(() =>
      decodeWalkthrough({
        ...WALKTHROUGH,
        notes: [{ ...WALKTHROUGH.notes[0], summary: "First line\nsecond line" }],
      }),
    ).toThrow(/single line/);
  });

  it("rejects a note whose range runs backwards", () => {
    expect(() =>
      decodeWalkthrough({
        ...WALKTHROUGH,
        notes: [{ ...WALKTHROUGH.notes[0], startLine: 21, endLine: 20 }],
      }),
    ).toThrow(/startLine must be less than or equal to endLine/);
  });

  it("rejects a thread diff range that runs backwards", () => {
    expect(() =>
      decodeTarget({ kind: "thread-diff", threadId: "thread-1", fromTurnCount: 3, toTurnCount: 2 }),
    ).toThrow(/fromTurnCount must be less than or equal to toTurnCount/);
  });
});

describe("diffWalkthroughTargetKey", () => {
  it("keys a pull request without its head, case-insensitively on host and repository", () => {
    const key = diffWalkthroughTargetKey(decodeTarget(PR_TARGET));
    expect(key).toBe("pull-request:host:github.com/pingdotgg/t3code#42");
    expect(
      diffWalkthroughTargetKey(
        decodeTarget({
          ...PR_TARGET,
          projectId: "project-2",
          host: "GitHub.com",
          repository: "PingDotGG/T3Code",
          headSha: "def456",
        }),
      ),
    ).toBe(key);
  });

  it("keys a pull request without a host to its project, apart from any host-level key", () => {
    const { host: _host, ...withoutHost } = PR_TARGET;
    const key = diffWalkthroughTargetKey(decodeTarget(withoutHost));
    expect(key).toBe("pull-request:project:project-1/pingdotgg/t3code#42");
    expect(key).toBe(diffWalkthroughTargetKey(decodeTarget({ ...withoutHost, headSha: "def456" })));
    expect(key).not.toBe(diffWalkthroughTargetKey(decodeTarget(PR_TARGET)));
  });

  it("keys a thread diff by its checkpoint pair", () => {
    const target = { kind: "thread-diff", threadId: "thread-1", fromTurnCount: 1, toTurnCount: 3 };
    expect(diffWalkthroughTargetKey(decodeTarget(target))).toBe("thread-diff:thread-1:1-3");
    expect(diffWalkthroughTargetKey(decodeTarget({ ...target, fromTurnCount: 2 }))).not.toBe(
      "thread-diff:thread-1:1-3",
    );
  });
});

describe("isDiffWalkthroughStale", () => {
  const walkthrough = decodeWalkthrough(WALKTHROUGH);

  it("is stale once the pull request's head moves", () => {
    expect(isDiffWalkthroughStale(walkthrough, decodeTarget(PR_TARGET))).toBe(false);
    expect(
      isDiffWalkthroughStale(walkthrough, decodeTarget({ ...PR_TARGET, headSha: "def" })),
    ).toBe(true);
  });

  it("never calls a thread diff stale", () => {
    const target = decodeTarget({
      kind: "thread-diff",
      threadId: "thread-1",
      fromTurnCount: 0,
      toTurnCount: 1,
    });
    expect(isDiffWalkthroughStale({ target }, target)).toBe(false);
  });
});

describe("groupDiffWalkthroughFiles", () => {
  const walkthrough = decodeWalkthrough(WALKTHROUGH);

  it("drops files the diff no longer touches and collects unplaced ones in a trailing Other", () => {
    const groups = groupDiffWalkthroughFiles(walkthrough, [
      "README.md",
      "apps/web/src/Rail.tsx",
      "packages/contracts/src/diffWalkthrough.ts",
      "docs/user/review.md",
    ]);
    expect(groups.map((group) => [group.id, group.files])).toEqual([
      ["contract", ["packages/contracts/src/diffWalkthrough.ts"]],
      ["ui", ["apps/web/src/Rail.tsx"]],
      [DIFF_WALKTHROUGH_OTHER_GROUP_ID, ["README.md", "docs/user/review.md"]],
    ]);
  });

  it("omits groups left empty and an empty Other", () => {
    const groups = groupDiffWalkthroughFiles(walkthrough, ["apps/web/src/Rail.css"]);
    expect(groups.map((group) => [group.id, group.files])).toEqual([
      ["ui", ["apps/web/src/Rail.css"]],
    ]);
  });
});
