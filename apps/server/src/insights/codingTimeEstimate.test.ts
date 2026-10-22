import { describe, expect, it } from "@effect/vitest";

import { estimateCodingTime, fileMix, fileWeight, hasAgentCoauthor } from "./codingTimeEstimate.ts";

describe("estimateCodingTime", () => {
  it("grows with the log of changed lines, not linearly", () => {
    const small = estimateCodingTime([{ path: "src/a.ts", additions: 100, deletions: 0 }]);
    const large = estimateCodingTime([{ path: "src/a.ts", additions: 1000, deletions: 0 }]);
    expect(large.hours / small.hours).toBeLessThan(2);
    expect(large.hours).toBeGreaterThan(small.hours);
  });

  it("spreads across files", () => {
    const one = estimateCodingTime([{ path: "src/a.ts", additions: 50, deletions: 50 }]);
    const four = estimateCodingTime(
      ["a", "b", "c", "d"].map((name) => ({
        path: `src/${name}.ts`,
        additions: 13,
        deletions: 12,
      })),
    );
    expect(four.hours).toBeGreaterThan(one.hours);
  });

  it("scores a lockfile bump as next to nothing", () => {
    const lockfile = estimateCodingTime([
      { path: "pnpm-lock.yaml", additions: 4000, deletions: 3500 },
    ]);
    const source = estimateCodingTime([{ path: "src/app.ts", additions: 40, deletions: 10 }]);
    expect(lockfile.hours).toBeLessThan(source.hours);
    expect(lockfile.fileMix).toBe(0.05);
  });

  it("clamps between three minutes and forty hours", () => {
    expect(estimateCodingTime([]).hours).toBe(0.05);
    expect(estimateCodingTime([{ path: "image.png", additions: 0, deletions: 0 }]).hours).toBe(
      0.05,
    );
  });
});

describe("fileMix", () => {
  it("weighs files by changed lines", () => {
    expect(
      fileMix([
        { path: "src/a.ts", additions: 30, deletions: 0 },
        { path: "src/a.test.ts", additions: 10, deletions: 0 },
      ]),
    ).toBeCloseTo((30 * 1 + 10 * 0.6) / 40);
  });

  it("falls back to the plain mean for binary-only commits", () => {
    expect(
      fileMix([
        { path: "docs/diagram.png", additions: 0, deletions: 0 },
        { path: "assets/logo.png", additions: 0, deletions: 0 },
      ]),
    ).toBeCloseTo((0.4 + 1) / 2);
  });

  it("classifies tests, docs and generated paths", () => {
    expect(fileWeight("apps/web/src/routeTree.gen.ts")).toBe(0.05);
    expect(fileWeight("vendor/lib/x.go")).toBe(0.05);
    expect(fileWeight("pkg/foo_test.go")).toBe(0.6);
    expect(fileWeight("README.md")).toBe(0.4);
    expect(fileWeight("src/server.ts")).toBe(1);
  });
});

describe("hasAgentCoauthor", () => {
  it("recognises agent trailers and ignores people", () => {
    expect(hasAgentCoauthor(["Claude Opus 5.5 <noreply@anthropic.com>"])).toBe(true);
    expect(hasAgentCoauthor(["Jane Doe <jane@example.com>"])).toBe(false);
  });
});
