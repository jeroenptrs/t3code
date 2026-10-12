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

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
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
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
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
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  /** The layer's head in the checkout, null where it could not be fetched. */
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  /** A disposable checkout of the change's head. The model investigates it read-only. */
  cwd: string;
  number: number;
  title: string;
  /** The author's own description, which states intent the diff cannot. */
  description: string;
  baseBranch: string;
  /** The commit the change is measured from, present in `cwd`. */
  baseCommit: string;
  /**
   * What review already settled: resolved conversations, reduced to who raised what. The guide
   * leaves these alone rather than raising them again.
   */
  settledReview: string;
  /** The maintainer's preferences for guides (tone, emphasis, ordering). Empty for none. */
  instructions?: string | undefined;
  /**
   * The stack the change is a layer of, bottom first, when it is in one. Another layer's head is
   * fetched into `cwd` where the host served it, so the model can read across a seam.
   */
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

/** A guide as the model wrote it, before the server holds it to the change. */
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

/** Commit, change request, branch, and title generation backed by one provider instance. */
export interface ProviderTextGeneration {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate change request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /** Generate a concise thread title from a first message or thread history. */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /** Explain a change request to the maintainer deciding whether it lands. */
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
