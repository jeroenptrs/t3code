import type {
  BranchNamingOptions,
  ChatAttachment,
  DiffWalkthrough,
  ModelSelection,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type { ThreadTitleForkSource } from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  threadContext?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  cwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

export interface DiffWalkthroughGenerationInput {
  /** A disposable checkout of the diff's head. The model investigates it read-only. */
  cwd: string;
  /** What the diff is, in a phrase: `pull request #12, "Add search"`, `branch feature/search`. */
  subject: string;
  /** The author's own description, when the diff has one. Empty for none. */
  description?: string | undefined;
  /** The commit the diff is measured from, present in `cwd`. */
  baseCommit: string;
  /** Whether `baseCommit..HEAD` is a history of commits; a checkpoint pair has none to read. */
  hasCommitHistory: boolean;
  /** `git diff --stat` of the diff, so the model starts from every file it must place. */
  stat: string;
  /** The user's preferences for guides, which walkthroughs share. Empty for none. */
  instructions?: string | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

/**
 * A walkthrough as the model wrote it, without what the server fills in, and not yet validated
 * against the contract.
 */
export type DiffWalkthroughGenerationResult = Omit<
  (typeof DiffWalkthrough)["Encoded"],
  "target" | "generatedAt" | "author"
>;

export interface ProviderTextGeneration {
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;

  /** Walk a reader through a diff: its files grouped by intent, with notes on the hunks. */
  readonly generateDiffWalkthrough: (
    input: DiffWalkthroughGenerationInput,
  ) => Effect.Effect<DiffWalkthroughGenerationResult, TextGenerationError>;

  /**
   * Why this provider cannot investigate a checkout read-only, or null when it can. When set,
   * `generateReviewGuide` and `generateDiffWalkthrough` fail with it, so a caller can refuse
   * before preparing a checkout for them.
   */
  readonly investigationRefusal: string | null;
}
