/**
 * Tier-1 coding time: a log-scaled function of a commit's diff, so a 2,000-line generated file
 * does not score as a week of work. It estimates how long writing the change by hand would take,
 * not how long anyone worked. The constants are starting points to calibrate against known weeks.
 */

export interface FileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface CodingTimeEstimate {
  readonly additions: number;
  readonly deletions: number;
  readonly filesChanged: number;
  readonly fileMix: number;
  readonly hours: number;
}

const BASE_HOURS_PER_LOG_LINE = 0.05;
const SPREAD_PER_LOG_FILE = 0.15;
const MIN_HOURS = 0.05;
const MAX_HOURS = 40;

const SOURCE_WEIGHT = 1;
const TEST_WEIGHT = 0.6;
const DOCS_WEIGHT = 0.4;
const GENERATED_WEIGHT = 0.05;

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "packages.lock.json",
  "flake.lock",
]);

const GENERATED_PATTERNS = [
  /(^|\/)(vendor|node_modules|third_party|dist)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
  /\.lock$/,
  /(^|[./_-])generated?\./,
  /\.gen\.[a-z]+$/,
  /_pb2(_grpc)?\.py$/,
  /\.pb(\.gw)?\.go$/,
  /\.designer\.cs$/,
];

const TEST_PATTERNS = [
  /(^|\/)(__tests__|tests?|spec|__mocks__)\//,
  /\.(test|spec)\.[a-z]+$/,
  /_test\.(go|py|rb|exs?)$/,
  /(^|\/)test_[^/]+\.py$/,
  /Tests?\.(cs|java|kt|swift)$/,
];

const DOCS_PATTERNS = [/\.(md|mdx|rst|adoc|txt)$/, /(^|\/)docs?\//];

/** How much a changed line in this file counts against a line of source. */
export function fileWeight(path: string): number {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (LOCKFILES.has(name) || GENERATED_PATTERNS.some((pattern) => pattern.test(lower))) {
    return GENERATED_WEIGHT;
  }
  if (TEST_PATTERNS.some((pattern) => pattern.test(path))) return TEST_WEIGHT;
  if (DOCS_PATTERNS.some((pattern) => pattern.test(lower))) return DOCS_WEIGHT;
  return SOURCE_WEIGHT;
}

/**
 * Weight per changed line across the commit. A commit whose files changed no countable lines
 * (binary files only) uses the plain mean, so it still has a weight.
 */
export function fileMix(files: ReadonlyArray<FileChange>): number {
  if (files.length === 0) return SOURCE_WEIGHT;
  let lines = 0;
  let weighted = 0;
  for (const file of files) {
    const changed = file.additions + file.deletions;
    lines += changed;
    weighted += changed * fileWeight(file.path);
  }
  if (lines > 0) return weighted / lines;
  return files.reduce((sum, file) => sum + fileWeight(file.path), 0) / files.length;
}

export function estimateCodingTime(files: ReadonlyArray<FileChange>): CodingTimeEstimate {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const mix = fileMix(files);
  const base = BASE_HOURS_PER_LOG_LINE * Math.log2(1 + additions + deletions);
  const spread = 1 + SPREAD_PER_LOG_FILE * Math.log2(1 + files.length);
  const hours = Math.min(MAX_HOURS, Math.max(MIN_HOURS, base * spread * mix));
  return { additions, deletions, filesChanged: files.length, fileMix: mix, hours };
}

const AGENT_COAUTHOR =
  /\b(claude|anthropic|codex|openai|copilot|cursor|gemini|grok|opencode|devin|aider|antigravity)\b/i;

/** True when a `Co-authored-by` trailer names a coding agent rather than a person. */
export function hasAgentCoauthor(coauthors: ReadonlyArray<string>): boolean {
  return coauthors.some((coauthor) => AGENT_COAUTHOR.test(coauthor));
}
