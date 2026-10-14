/**
 * JiraProposals - Jira writes an agent proposes and a signed-in user approves.
 *
 * An agent proposes creating issues, posting a comment or moving an issue; the proposal is a
 * card in its thread. Only a user deciding it from a client approves or rejects it, and an
 * approval writes to Jira with that user's own personal token, never a service identity. The
 * card outlives the run that proposed it.
 *
 * The turn item is what clients see. The `fork_jira_proposals` ledger is what makes an approval
 * idempotent: it holds the approval's claim and every issue and step already written, so a
 * repeated or retried approval writes only what is missing.
 *
 * @module JiraProposals
 */
import {
  CommandId,
  JiraError,
  JiraProposal,
  JiraProposalResult,
  JiraProposalStatus,
  type AuthUserId,
  type JiraIssueDraft,
  type JiraProposalDecisionInput,
  type JiraProposalDecisionResult,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  isTerminalRunStatus,
  latestActiveRun,
} from "../orchestration-v2/ThreadManagementService.ts";
import * as JiraApi from "./JiraApi.ts";
import { normalizeJiraSite, type JiraServerIdentity } from "./JiraConfig.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import * as JiraService from "./JiraService.ts";
import * as JiraUserCredentials from "./JiraUserCredentials.ts";
import { browseUrl, toTransition } from "./issueMapping.ts";
import { makeKeyedLock } from "./keyedLock.ts";
import { markdownToAdf } from "./markdownToAdf.ts";

export class JiraProposalRunInactiveError extends Schema.TaggedError<JiraProposalRunInactiveError>()(
  "JiraProposalRunInactiveError",
  {},
) {
  override get message(): string {
    return "Proposing a Jira change requires an active run owned by this MCP provider session.";
  }
}

export class JiraProposalRecordError extends Schema.TaggedError<JiraProposalRecordError>()(
  "JiraProposalRecordError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not record the Jira proposal.";
  }
}

/** A draft as an agent writes it: everything but project, type and summary may be left out. */
type JiraIssueDraftInput = Pick<JiraIssueDraft, "projectKey" | "issueType" | "summary"> & {
  readonly [K in Exclude<keyof JiraIssueDraft, "projectKey" | "issueType" | "summary">]?:
    | JiraIssueDraft[K]
    | undefined;
};

/** What an agent asks for. `site` defaults to the site T3 Code reads Jira from. */
export type JiraProposalRequest =
  | {
      readonly kind: "create-issues";
      readonly site?: string | undefined;
      readonly issues: ReadonlyArray<JiraIssueDraftInput>;
    }
  | {
      readonly kind: "comment";
      readonly site?: string | undefined;
      readonly key: string;
      readonly body: string;
    }
  | {
      readonly kind: "transition";
      readonly site?: string | undefined;
      readonly key: string;
      /** A transition id or name, or the name of the status it leads to. */
      readonly transition: string;
      readonly comment?: string | null | undefined;
    };

export interface JiraProposalOutcome {
  readonly proposalId: TurnItemId;
  readonly status: JiraProposalStatus;
  readonly result: JiraProposalResult | null;
  readonly error: string | null;
}

export class JiraProposals extends Context.Service<
  JiraProposals,
  {
    /**
     * Records a proposal in the calling thread's active run and waits up to `timeoutMs` for the
     * user to decide it. A wait that ends first, by timeout or with the run, leaves the card open
     * and reports it pending (or approved, while it is being written). Proposing again with the
     * same `clientRequestId` finds the same card; without one, so does proposing the same change
     * again from the same run or its restart continuations.
     */
    readonly propose: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly request: JiraProposalRequest;
      readonly clientRequestId?: string | undefined;
      readonly timeoutMs?: number | undefined;
    }) => Effect.Effect<
      JiraProposalOutcome,
      JiraError | JiraProposalRunInactiveError | JiraProposalRecordError
    >;
    /**
     * Approves, with the approver's edits, or rejects a proposal. Only a signed-in user decides,
     * and an approval writes to Jira with their own personal token. Deciding one already decided
     * returns its current outcome.
     */
    readonly decide: (
      userId: AuthUserId | undefined,
      input: JiraProposalDecisionInput,
    ) => Effect.Effect<JiraProposalDecisionResult, JiraError>;
    /**
     * Fails every approval no one is writing anymore, such as one a previous server process left
     * mid-write, so its card can be approved again or rejected. Run once at startup.
     */
    readonly recoverInterrupted: Effect.Effect<void>;
  }
>()("t3/jira/JiraProposals") {}

type ProposalItem = Extract<OrchestrationV2TurnItem, { readonly type: "jira_proposal" }> & {
  readonly runId: NonNullable<OrchestrationV2TurnItem["runId"]>;
  readonly nodeId: NonNullable<OrchestrationV2TurnItem["nodeId"]>;
};

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const INTERRUPTED = "Interrupted before it finished; approve again to finish what is missing.";
const PROGRESS_UNSAVED =
  "T3 Code could not save what it wrote to Jira; approve again to finish what is missing.";
const APPROVAL_UNRECORDED = "T3 Code could not record the approval; approve again.";
const FINAL_STATUSES: ReadonlySet<JiraProposalStatus> = new Set(["applied", "rejected", "failed"]);
/** The card's item statuses for those, as the thread's events carry them. */
const SETTLED_ITEM_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

/**
 * What an approval has written so far: the issues, the steps done for a transition or comment,
 * and the drafts whose story points and sprint were set after creating them.
 */
const Progress = Schema.Struct({
  issues: JiraProposalResult.fields.issues,
  steps: Schema.Array(Schema.Literals(["transition", "comment"])),
  edited: Schema.optional(Schema.Array(Schema.Int)),
});
type Progress = typeof Progress.Type;
const ProgressJson = Schema.fromJsonString(Progress);
const decodeProgress = Schema.decodeUnknownEffect(ProgressJson);
const encodeProgress = Schema.encodeEffect(ProgressJson);
const encodeProposal = Schema.encodeEffect(Schema.fromJsonString(JiraProposal));
const EMPTY_PROGRESS: Progress = { issues: [], steps: [] };

/** Everything either one says was written. */
const mergeProgress = (left: Progress, right: Progress | undefined): Progress => {
  if (right === undefined) return left;
  const issues = [...left.issues];
  for (const entry of right.issues) {
    if (!issues.some((known) => known.key === entry.key)) issues.push(entry);
  }
  const edited = [...new Set([...(left.edited ?? []), ...(right.edited ?? [])])];
  return {
    issues,
    steps: [...new Set([...left.steps, ...right.steps])],
    ...(edited.length === 0 ? {} : { edited }),
  };
};

const LedgerRow = Schema.Struct({
  status: JiraProposalStatus,
  claimId: Schema.NullOr(Schema.String),
  claimedAt: Schema.NullOr(Schema.String),
  progressJson: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
type LedgerRow = typeof LedgerRow.Type;
const decodeLedgerRows = Schema.decodeUnknownEffect(Schema.Array(LedgerRow));

const signInRequired = new JiraError({
  reason: "forbidden",
  message: "Sign in to T3 Code with your organisation account to approve or reject Jira proposals.",
});

const personalTokenRequired = new JiraError({
  reason: "personal-token-required",
  message:
    "Add your own Jira token in Settings → Account to approve this. T3 Code never makes approved changes with a shared account.",
});

const notFound = new JiraError({
  reason: "not-found",
  message: "The Jira proposal was not found.",
});

const rolledBack = new JiraError({
  reason: "not-found",
  message: "This Jira proposal is no longer available; the turn that proposed it was rolled back.",
});

const ledgerFailed = () =>
  new JiraError({ reason: "unavailable", message: "Could not read or record the Jira proposal." });

const isProposalItem = (item: OrchestrationV2TurnItem | undefined): item is ProposalItem =>
  item?.type === "jira_proposal" && item.runId !== null && item.nodeId !== null;

const proposalSite = (proposal: JiraProposal) => normalizeJiraSite(proposal.site) ?? proposal.site;

const outcomeOf = (item: ProposalItem): JiraProposalDecisionResult => ({
  status: item.proposalStatus,
  result: item.result ?? null,
  error: item.error ?? null,
});

const toDraft = (draft: JiraIssueDraftInput): JiraIssueDraft => ({
  projectKey: draft.projectKey,
  issueType: draft.issueType,
  summary: draft.summary,
  description: draft.description ?? null,
  parentKey: draft.parentKey ?? null,
  labels: draft.labels ?? [],
  storyPoints: draft.storyPoints ?? null,
  sprintId: draft.sprintId ?? null,
  assigneeAccountId: draft.assigneeAccountId ?? null,
});

/** Jira's create body for one draft: the fields every create screen has. */
const createFields = (draft: JiraIssueDraft): Record<string, unknown> => ({
  project: { key: draft.projectKey },
  issuetype: { name: draft.issueType },
  summary: draft.summary,
  ...(draft.description === null || draft.description.trim().length === 0
    ? {}
    : { description: markdownToAdf(draft.description) }),
  ...(draft.parentKey === null ? {} : { parent: { key: draft.parentKey } }),
  ...(draft.labels.length === 0 ? {} : { labels: draft.labels }),
  ...(draft.assigneeAccountId === null ? {} : { assignee: { accountId: draft.assigneeAccountId } }),
});

/**
 * Story points and sprint, set by editing the created issue: many projects leave them off the
 * create screen, where Jira refuses the whole create. Null when there is nothing to set; a field
 * the site has no id for is left out.
 */
const followUpFields = (
  draft: JiraIssueDraft,
  fieldIds: { readonly storyPoints: string | null; readonly sprint: string | null },
): Record<string, unknown> | null => {
  const fields = {
    ...(draft.storyPoints === null || fieldIds.storyPoints === null
      ? {}
      : { [fieldIds.storyPoints]: draft.storyPoints }),
    ...(draft.sprintId === null || fieldIds.sprint === null
      ? {}
      : { [fieldIds.sprint]: draft.sprintId }),
  };
  return Object.keys(fields).length === 0 ? null : fields;
};

/** An approver may edit a proposal, but not into another kind, site or issue. */
const checkEdit = (
  proposed: JiraProposal,
  approved: JiraProposal,
  progress: Progress,
): Effect.Effect<void, JiraError> => {
  const invalid = (message: string) => Effect.fail(new JiraError({ reason: "invalid", message }));
  if (approved.kind !== proposed.kind)
    return invalid("An approval cannot change what kind of change is proposed.");
  if (proposalSite(approved) !== proposalSite(proposed))
    return invalid("An approval cannot move the proposal to another Jira site.");
  if (
    (approved.kind === "comment" || approved.kind === "transition") &&
    (proposed.kind === "comment" || proposed.kind === "transition") &&
    approved.key !== proposed.key
  )
    return invalid("An approval cannot move the proposal to another issue.");
  // Created issues are matched to their drafts by position.
  if (
    approved.kind === "create-issues" &&
    proposed.kind === "create-issues" &&
    progress.issues.length > 0 &&
    approved.issues.length !== proposed.issues.length
  )
    return invalid("Some issues were already created; keep every draft when approving again.");
  return Effect.void;
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const identities = yield* JiraIdentities.JiraIdentities;
  const credentials = yield* JiraUserCredentials.JiraUserCredentials;
  const jira = yield* JiraService.JiraService;
  const api = yield* JiraApi.JiraApi;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * Decisions on one proposal, and its recovery, run one at a time. One server owns the
   * database, so a ledger row read under this lock that says approved was left by an approval
   * that is no longer writing: one that died with its process or could not record its end.
   */
  const exclusive = makeKeyedLock<string>().withLock;
  /**
   * Progress Jira confirmed but the ledger could not store, by proposal. Approving again starts
   * from it, so a retry never repeats a write the ledger missed.
   */
  const unsaved = new Map<string, Progress>();

  // ---- ledger -------------------------------------------------------------------------------

  const readLedger = (proposalId: string) =>
    sql`
      SELECT status, claim_id AS "claimId", claimed_at AS "claimedAt",
        progress_json AS "progressJson", error
      FROM fork_jira_proposals WHERE proposal_id = ${proposalId}
    `.pipe(
      Effect.flatMap(decodeLedgerRows),
      Effect.map((rows): LedgerRow | null => rows[0] ?? null),
      Effect.mapError(ledgerFailed),
    );

  const insertLedger = (input: {
    readonly proposalId: string;
    readonly threadId: ThreadId;
    readonly proposal: JiraProposal;
    readonly run: OrchestrationV2Run | undefined;
  }) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const proposalJson = yield* encodeProposal(input.proposal);
      yield* sql`
        INSERT INTO fork_jira_proposals (
          proposal_id, thread_id, kind, site, status, requested_by_provider_instance_id,
          requested_model, proposal_json, created_at, updated_at
        ) VALUES (
          ${input.proposalId}, ${input.threadId}, ${input.proposal.kind},
          ${proposalSite(input.proposal)}, 'pending', ${input.run?.providerInstanceId ?? "unknown"},
          ${input.run?.modelSelection.model ?? null}, ${proposalJson}, ${now}, ${now}
        )
        ON CONFLICT (proposal_id) DO NOTHING
      `;
    }).pipe(Effect.mapError(ledgerFailed));

  const progressOf = (row: LedgerRow) =>
    row.progressJson === null
      ? Effect.succeed(EMPTY_PROGRESS)
      : decodeProgress(row.progressJson).pipe(Effect.mapError(ledgerFailed));

  const writeProgress = (proposalId: string, progress: Progress) =>
    Effect.gen(function* () {
      const json = yield* encodeProgress(progress);
      yield* sql`
        UPDATE fork_jira_proposals SET progress_json = ${json}, updated_at = ${yield* nowIso}
        WHERE proposal_id = ${proposalId}
      `;
    }).pipe(Effect.mapError(ledgerFailed));

  /**
   * Takes the ledger row for one approval, unless it is already applied or rejected. Called
   * under the proposal's lock, where an approved row is one no approval is writing anymore.
   */
  const claim = (input: {
    readonly proposalId: string;
    readonly claimId: string;
    readonly userId: AuthUserId;
    readonly proposal: JiraProposal;
    readonly claimedAt: string;
  }) =>
    Effect.gen(function* () {
      const proposalJson = yield* encodeProposal(input.proposal);
      const rows = yield* sql<{ readonly proposal_id: string }>`
        UPDATE fork_jira_proposals SET
          status = 'approved', claim_id = ${input.claimId}, claimed_at = ${input.claimedAt},
          approved_by_user_id = ${input.userId}, approved_at = ${input.claimedAt},
          proposal_json = ${proposalJson}, error = NULL, updated_at = ${input.claimedAt}
        WHERE proposal_id = ${input.proposalId}
          AND status IN ('pending', 'failed', 'approved')
        RETURNING proposal_id
      `;
      return rows.length > 0;
    }).pipe(Effect.mapError(ledgerFailed));

  /**
   * Ends an approval, or a rejection, in the ledger. `progress`, when given, is stored with it,
   * so what Jira confirmed is kept even if storing it step by step failed. The claim id stays as
   * the name of the approval that ended.
   */
  const settleLedger = (
    proposalId: string,
    status: "applied" | "failed" | "rejected",
    error: string | null,
    progress?: Progress,
  ) =>
    Effect.gen(function* () {
      const json = progress === undefined ? null : yield* encodeProgress(progress);
      yield* sql`
        UPDATE fork_jira_proposals SET status = ${status}, error = ${error},
          progress_json = COALESCE(${json}, progress_json), claimed_at = NULL,
          updated_at = ${yield* nowIso}
        WHERE proposal_id = ${proposalId}
      `;
    }).pipe(Effect.mapError(ledgerFailed));

  // ---- the card -----------------------------------------------------------------------------

  const loadProposal = (threadId: ThreadId, proposalId: string) =>
    engine
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["jira_proposal"],
        messageRoles: [],
      })
      .pipe(
        Effect.map((records) => {
          const item = records.turnItems.find((candidate) => candidate.id === proposalId);
          if (!isProposalItem(item) || records.thread.deletedAt !== null) return null;
          return { item, run: records.runs.find((run) => run.id === item.runId) };
        }),
        Effect.catchTags({
          OrchestratorProjectionError: () => Effect.succeed(null),
        }),
      );

  /** Moves the card to `update.proposalStatus`; the orchestrator refuses a move it does not allow. */
  const record = (
    item: Pick<ProposalItem, "id" | "threadId" | "runId" | "nodeId">,
    commandId: string,
    update: {
      readonly proposal: JiraProposal;
      readonly proposalStatus: JiraProposalStatus;
      readonly decidedByUserId?: AuthUserId | undefined;
      readonly decidedAt?: string | undefined;
      readonly result?: JiraProposalResult | undefined;
      readonly error?: string | undefined;
    },
  ) =>
    engine.dispatch({
      type: "jira_proposal.record",
      commandId: CommandId.make(commandId),
      threadId: item.threadId,
      runId: item.runId,
      nodeId: item.nodeId,
      turnItemId: TurnItemId.make(item.id),
      proposal: update.proposal,
      proposalStatus: update.proposalStatus,
      ...(update.decidedByUserId === undefined ? {} : { decidedByUserId: update.decidedByUserId }),
      ...(update.decidedAt === undefined ? {} : { decidedAt: update.decidedAt }),
      ...(update.result === undefined ? {} : { result: update.result }),
      ...(update.error === undefined ? {} : { error: update.error }),
    });

  // ---- propose ------------------------------------------------------------------------------

  /** The site an agent named, normalized, or the reader's; it must be a configured one. */
  const resolveSite = (requested: string | undefined) =>
    Effect.gen(function* () {
      if (requested === undefined) return (yield* identities.reader).site;
      const site = normalizeJiraSite(requested);
      if (site === null) {
        return yield* new JiraError({
          reason: "invalid",
          message: "site must be a Jira site host such as acme.atlassian.net.",
        });
      }
      return (yield* identities.forSite(site)).site;
    });

  /** Matches a transition by id, name or target status, as T3 Code's own reader sees the issue. */
  const resolveTransition = (site: string, key: string, wanted: string) =>
    Effect.gen(function* () {
      const reader = yield* identities.forSite(site);
      const transitions = (yield* api.getTransitions(reader, key)).map(toTransition);
      const needle = wanted.trim().toLowerCase();
      const match =
        transitions.find((transition) => transition.id === wanted.trim()) ??
        transitions.find((transition) => transition.name.toLowerCase() === needle) ??
        transitions.find((transition) => transition.toStatus.toLowerCase() === needle);
      if (match !== undefined) return match;
      const available = transitions
        .map((transition) => `${transition.name} (→ ${transition.toStatus})`)
        .join(", ");
      return yield* new JiraError({
        reason: "invalid",
        message:
          available.length === 0
            ? `${key} has no transitions available.`
            : `No transition "${wanted}" on ${key}. Available: ${available}.`,
      });
    });

  const buildProposal = (request: JiraProposalRequest) =>
    Effect.gen(function* () {
      const site = yield* resolveSite(request.site);
      switch (request.kind) {
        case "create-issues":
          return { kind: "create-issues", site, issues: request.issues.map(toDraft) } as const;
        case "comment":
          return { kind: "comment", site, key: request.key, body: request.body } as const;
        case "transition": {
          const transition = yield* resolveTransition(site, request.key, request.transition);
          return {
            kind: "transition",
            site,
            key: request.key,
            transitionId: transition.id,
            transitionName: transition.name,
            comment: request.comment ?? null,
          } as const;
        }
      }
    });

  /**
   * Waits, on the thread's events after `afterSequence`, for the card to settle or the run that
   * would hear it to end, then reports the card as it is. The card stays open either way.
   */
  const awaitOutcome = (input: {
    readonly threadId: ThreadId;
    readonly proposalId: TurnItemId;
    readonly runId: string;
    readonly afterSequence: number;
    readonly timeoutMs: number;
  }) =>
    Effect.gen(function* () {
      const current = loadProposal(input.threadId, input.proposalId).pipe(
        Effect.mapError(
          (cause) => new JiraProposalRecordError({ threadId: input.threadId, cause }),
        ),
      );
      const loaded = yield* current;
      const waiting =
        loaded !== null &&
        !FINAL_STATUSES.has(loaded.item.proposalStatus) &&
        loaded.run !== undefined &&
        !isTerminalRunStatus(loaded.run.status);
      if (waiting) {
        yield* engine
          .streamStoredEventsFrom({ threadId: input.threadId, afterSequence: input.afterSequence })
          .pipe(
            Stream.filter(({ event }) =>
              event.type === "turn-item.updated"
                ? event.payload.id === input.proposalId &&
                  SETTLED_ITEM_STATUSES.has(event.payload.status)
                : event.type === "run.updated" &&
                  event.payload.id === input.runId &&
                  isTerminalRunStatus(event.payload.status),
            ),
            Stream.runHead,
            Effect.timeoutOption(Duration.millis(input.timeoutMs)),
            // A wait that cannot follow the thread reports the card as it is now.
            Effect.catch((error) =>
              Effect.logWarning("Stopped waiting for a Jira proposal", { errorTag: error._tag }),
            ),
          );
      }
      const item = waiting ? ((yield* current)?.item ?? null) : (loaded?.item ?? null);
      if (item === null) {
        return yield* new JiraProposalRecordError({
          threadId: input.threadId,
          cause: "The proposal card disappeared.",
        });
      }
      return { proposalId: input.proposalId, ...outcomeOf(item) };
    });

  /**
   * The key of a proposal made without a `clientRequestId`: the change itself, in the run that
   * proposed it. A restart continuation counts as the run it continues, so an agent that picks
   * up after a restart and proposes the same change again finds the same card.
   */
  const requestKey = (
    run: OrchestrationV2Run,
    runs: ReadonlyArray<OrchestrationV2Run>,
    request: JiraProposalRequest,
  ) => {
    let origin = run;
    for (let hops = 0; origin.restartContinuationOfRunId !== undefined && hops < 100; hops++) {
      const previous = runs.find((candidate) => candidate.id === origin.restartContinuationOfRunId);
      if (previous === undefined) break;
      origin = previous;
    }
    // Drafts with defaults left out and spelled out are the same change.
    const change =
      request.kind === "create-issues"
        ? { ...request, issues: request.issues.map(toDraft) }
        : request;
    const content = new TextEncoder().encode(JSON.stringify([origin.id, change]));
    return crypto.digest("SHA-256", content).pipe(
      Effect.map((digest) => `auto:${Buffer.from(digest).toString("base64url")}`),
      Effect.orDie,
    );
  };

  const propose: JiraProposals["Service"]["propose"] = Effect.fn("JiraProposals.propose")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "jira_proposal.kind": input.request.kind,
      });
      const recordFailed = (cause: unknown) =>
        new JiraProposalRecordError({ threadId: input.threadId, cause });
      const records = yield* engine
        .getThreadRecords(input.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["jira_proposal"],
          messageRoles: [],
        })
        .pipe(Effect.mapError(recordFailed));
      const run = latestActiveRun(records);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== input.providerInstanceId
      ) {
        return yield* new JiraProposalRunInactiveError();
      }
      const key = input.clientRequestId ?? (yield* requestKey(run, records.runs, input.request));
      // Turn item ids are global; scope the key to this thread. A retry with the same key finds
      // this card, decided or not.
      const proposalId = TurnItemId.make(
        `turn-item:jira-proposal:${encodeURIComponent(input.threadId)}:${encodeURIComponent(key)}`,
      );
      const existing = records.turnItems.find((item) => item.id === proposalId);
      const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
      if (isProposalItem(existing)) {
        // Read after the sequence, so a decision landing in between is either seen or streamed.
        const afterSequence = yield* engine
          .getThreadEventSequence(input.threadId)
          .pipe(Effect.mapError(recordFailed));
        return yield* awaitOutcome({
          threadId: input.threadId,
          proposalId,
          runId: existing.runId,
          afterSequence,
          timeoutMs,
        });
      }
      const proposal = yield* buildProposal(input.request);
      yield* insertLedger({ proposalId, threadId: input.threadId, proposal, run });
      const recorded = yield* record(
        { id: proposalId, threadId: input.threadId, runId: run.id, nodeId: run.rootNodeId },
        `jira-proposal:${proposalId}:pending`,
        { proposal, proposalStatus: "pending" },
      ).pipe(Effect.mapError(recordFailed));
      return yield* awaitOutcome({
        threadId: input.threadId,
        proposalId,
        runId: run.id,
        afterSequence: recorded.sequence,
        timeoutMs,
      });
    },
  );

  // ---- decide -------------------------------------------------------------------------------

  /** A personal token Jira rejects is recorded on the credential, as for the user's reads. */
  const asApprover =
    (identity: JiraServerIdentity) =>
    <A>(effect: Effect.Effect<A, JiraError>): Effect.Effect<A, JiraError> =>
      effect.pipe(
        Effect.catchTags({
          JiraError: (error) =>
            error.reason !== "unauthorized"
              ? Effect.fail(error)
              : credentials.recordRejected(identity, error.message).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.fail(
                      new JiraError({
                        reason: "unauthorized",
                        message:
                          "Jira rejected your personal Jira token. Update it in Settings → Account and approve again.",
                      }),
                    ),
                  ),
                ),
        }),
      );

  /**
   * Writes what the ledger does not have yet, recording each step as Jira confirms it. `progress`
   * holds every confirmed step even when storing it failed, which stops the writing: the caller
   * stores it again with the approval's end, and nothing is written past a step the ledger may
   * not know about.
   */
  const apply = (
    proposalId: string,
    proposal: JiraProposal,
    identity: JiraServerIdentity,
    progress: Ref.Ref<Progress>,
  ): Effect.Effect<void, JiraError> => {
    const advance = (next: (current: Progress) => Progress) =>
      Ref.updateAndGet(progress, next).pipe(
        Effect.flatMap((updated) => writeProgress(proposalId, updated)),
      );
    const issue = (key: string, draftIndex?: number) => ({
      site: identity.site,
      key,
      url: browseUrl(identity.site, key),
      ...(draftIndex === undefined ? {} : { draftIndex }),
    });
    const withIssue = (current: Progress, key: string) =>
      current.issues.some((entry) => entry.key === key)
        ? current
        : { ...current, issues: [...current.issues, issue(key)] };
    return Effect.gen(function* () {
      switch (proposal.kind) {
        case "create-issues": {
          const fieldIds = yield* jira.fieldIds(identity);
          for (const [index, draft] of proposal.issues.entries()) {
            let key = (yield* Ref.get(progress)).issues.find(
              (entry) => entry.draftIndex === index,
            )?.key;
            if (key === undefined) {
              const created = yield* api.createIssue(identity, createFields(draft));
              key = created.key;
              yield* advance((current) => ({
                ...current,
                issues: [...current.issues, issue(created.key, index)],
              }));
            }
            const followUp = followUpFields(draft, fieldIds);
            if (followUp === null || (yield* Ref.get(progress)).edited?.includes(index)) continue;
            const created = key;
            yield* api.editIssue(identity, created, followUp).pipe(
              Effect.mapError(
                (error) =>
                  new JiraError({
                    reason: error.reason,
                    message: `Created ${created}, but Jira did not take its story points or sprint: ${error.message}`,
                  }),
              ),
            );
            yield* advance((current) => ({
              ...current,
              edited: [...(current.edited ?? []), index],
            }));
          }
          return;
        }
        case "comment": {
          if ((yield* Ref.get(progress)).steps.includes("comment")) return;
          const posted = yield* api.addComment(
            identity,
            proposal.key,
            markdownToAdf(proposal.body),
          );
          yield* jira.recordPostedComment(identity.site, proposal.key, posted.id);
          yield* advance((current) => ({
            ...withIssue(current, proposal.key),
            steps: [...current.steps, "comment"],
          }));
          return;
        }
        case "transition": {
          if (!(yield* Ref.get(progress)).steps.includes("transition")) {
            const available = yield* api.getTransitions(identity, proposal.key);
            if (!available.some((transition) => transition.id === proposal.transitionId)) {
              return yield* new JiraError({
                reason: "invalid",
                message: `"${proposal.transitionName}" is no longer available on ${proposal.key}; it may have moved since this was proposed.`,
              });
            }
            yield* api.transitionIssue(identity, proposal.key, proposal.transitionId);
            yield* advance((current) => ({
              ...withIssue(current, proposal.key),
              steps: [...current.steps, "transition"],
            }));
          }
          if (
            proposal.comment !== null &&
            proposal.comment.trim().length > 0 &&
            !(yield* Ref.get(progress)).steps.includes("comment")
          ) {
            const posted = yield* api.addComment(
              identity,
              proposal.key,
              markdownToAdf(proposal.comment),
            );
            yield* jira.recordPostedComment(identity.site, proposal.key, posted.id);
            yield* advance((current) => ({ ...current, steps: [...current.steps, "comment"] }));
          }
          return;
        }
      }
    }).pipe(asApprover(identity));
  };

  /** Links the issues an approval wrote to the thread, as the approver's doing. */
  const linkIssues = (
    threadId: ThreadId,
    proposalId: string,
    issues: Progress["issues"],
    userId: AuthUserId,
  ) =>
    Effect.gen(function* () {
      if (issues.length === 0) return;
      const shell = yield* engine.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return;
      const linked = (shell.jiraIssues ?? []).filter((link) => link.source !== "branch-dismissed");
      for (const entry of issues) {
        if (linked.some((link) => link.site === entry.site && link.key === entry.key)) continue;
        yield* engine.dispatch({
          type: "thread.jira-issue.link",
          commandId: CommandId.make(`jira-proposal:${proposalId}:link:${entry.site}:${entry.key}`),
          threadId,
          site: entry.site,
          key: entry.key,
          source: "agent",
          linkedByUserId: userId,
        });
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not link the issues a Jira proposal wrote", {
          errorTag: error._tag,
        }),
      ),
    );

  const recordFailedDecision = (error: Orchestrator.OrchestratorV2Error) =>
    Effect.logWarning("Could not record a Jira proposal decision", { errorTag: error._tag }).pipe(
      Effect.andThen(Effect.fail(ledgerFailed())),
    );

  /** Whether the card may move from `from` to the ledger's `to`, as the orchestrator allows. */
  const repairable = (from: JiraProposalStatus, to: LedgerRow["status"]) =>
    (from === "approved" && (to === "applied" || to === "failed")) ||
    ((from === "pending" || from === "failed") && to === "rejected");

  /** Brings the card in line with a ledger that already settled, then reports it. */
  const outcomeFromLedger = (item: ProposalItem, row: LedgerRow) =>
    Effect.gen(function* () {
      const progress = yield* progressOf(row);
      const result = { issues: progress.issues };
      if (repairable(item.proposalStatus, row.status)) {
        yield* record(
          item,
          `jira-proposal:${item.id}:${row.status}:${row.claimId ?? "unclaimed"}:repair`,
          {
            proposal: item.proposal,
            proposalStatus: row.status,
            ...(item.decidedByUserId === undefined
              ? {}
              : { decidedByUserId: item.decidedByUserId }),
            ...(item.decidedAt === undefined ? {} : { decidedAt: item.decidedAt }),
            result,
            ...(row.error === null ? {} : { error: row.error }),
          },
        ).pipe(Effect.catch(recordFailedDecision));
      }
      return {
        status: row.status === "pending" ? item.proposalStatus : row.status,
        result: progress.issues.length > 0 ? result : (item.result ?? null),
        error: row.error,
      } satisfies JiraProposalDecisionResult;
    });

  /**
   * Ends a claimed approval in the ledger and on its card. What Jira confirmed is stored with
   * the end, a second time when it fails; if both fail it is kept for the next approval to
   * start from, and the card says failed, since the ledger does not know what was written.
   */
  const finishApproval = (input: {
    readonly item: ProposalItem;
    readonly claimId: string;
    readonly proposal: JiraProposal;
    readonly decided: { readonly decidedByUserId: AuthUserId; readonly decidedAt: string };
    readonly status: "applied" | "failed";
    readonly error: string | null;
    readonly written: Progress;
  }) =>
    Effect.gen(function* () {
      const { item, written } = input;
      const settled = yield* Effect.result(
        settleLedger(item.id, input.status, input.error, written).pipe(Effect.retry({ times: 1 })),
      );
      if (settled._tag === "Failure") {
        unsaved.set(item.id, written);
        yield* Effect.logWarning("Could not store what a Jira approval wrote", {
          proposalId: item.id,
        });
      } else {
        unsaved.delete(item.id);
      }
      const status = settled._tag === "Failure" ? "failed" : input.status;
      const error = settled._tag === "Failure" ? PROGRESS_UNSAVED : input.error;
      const result = { issues: written.issues };
      // The command id names this approval, so a second attempt replays a first that landed.
      yield* record(item, `jira-proposal:${item.id}:${status}:${input.claimId}`, {
        proposal: input.proposal,
        proposalStatus: status,
        ...input.decided,
        result,
        ...(error === null ? {} : { error }),
      }).pipe(Effect.retry({ times: 1 }), Effect.catch(recordFailedDecision));
      return { status, result, error } satisfies JiraProposalDecisionResult;
    });

  const approve = (
    userId: AuthUserId,
    item: ProposalItem,
    edited: JiraProposal,
    row: LedgerRow,
  ): Effect.Effect<JiraProposalDecisionResult, JiraError> =>
    Effect.gen(function* () {
      const stored = mergeProgress(yield* progressOf(row), unsaved.get(item.id));
      yield* checkEdit(item.proposal, edited, stored);
      const site = proposalSite(item.proposal);
      const proposal: JiraProposal = { ...edited, site };
      const identity = yield* credentials.identityFor(userId, site);
      if (identity === undefined) return yield* personalTokenRequired;
      const claimedAt = yield* nowIso;
      // Names this approval's records, so a later approval is never mistaken for a replay.
      const claimId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      if (!(yield* claim({ proposalId: item.id, claimId, userId, proposal, claimedAt }))) {
        const current = yield* readLedger(item.id);
        return current === null ? outcomeOf(item) : yield* outcomeFromLedger(item, current);
      }
      // The ledger is ours until it settles; a client hanging up must not strand it approved.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const decided = { decidedByUserId: userId, decidedAt: claimedAt };
          const shown = yield* Effect.result(
            record(item, `jira-proposal:${item.id}:approved:${claimId}`, {
              proposal,
              proposalStatus: "approved",
              ...decided,
              ...(stored.issues.length === 0 ? {} : { result: { issues: stored.issues } }),
            }),
          );
          if (shown._tag === "Failure") {
            // Nothing was written. The ledger goes back to claimable; the card, in case the
            // approval landed anyway, to failed, which may be approved again or rejected.
            yield* settleLedger(item.id, "failed", APPROVAL_UNRECORDED).pipe(Effect.ignore);
            yield* record(item, `jira-proposal:${item.id}:failed:${claimId}`, {
              proposal,
              proposalStatus: "failed",
              ...decided,
              ...(stored.issues.length === 0 ? {} : { result: { issues: stored.issues } }),
              error: APPROVAL_UNRECORDED,
            }).pipe(Effect.ignore);
            return yield* recordFailedDecision(shown.failure);
          }
          const progress = yield* Ref.make(stored);
          const applied = yield* Effect.result(apply(item.id, proposal, identity, progress));
          const written = yield* Ref.get(progress);
          const error = applied._tag === "Failure" ? applied.failure.message : null;
          const outcome = yield* finishApproval({
            item,
            claimId,
            proposal,
            decided,
            status: error === null ? "applied" : "failed",
            error,
            written,
          });
          yield* linkIssues(item.threadId, item.id, written.issues, userId);
          return outcome;
        }),
      );
    });

  const reject = (userId: AuthUserId, item: ProposalItem) =>
    Effect.gen(function* () {
      if (item.proposalStatus !== "pending" && item.proposalStatus !== "failed") {
        return outcomeOf(item);
      }
      const decidedAt = yield* nowIso;
      yield* settleLedger(item.id, "rejected", null, unsaved.get(item.id));
      unsaved.delete(item.id);
      yield* record(item, `jira-proposal:${item.id}:rejected`, {
        proposal: item.proposal,
        proposalStatus: "rejected",
        decidedByUserId: userId,
        decidedAt,
        ...(item.result === undefined ? {} : { result: item.result }),
      }).pipe(Effect.catch(recordFailedDecision));
      return { status: "rejected", result: item.result ?? null, error: null } as const;
    });

  const decide: JiraProposals["Service"]["decide"] = Effect.fn("JiraProposals.decide")(
    function* (userId, input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "jira_proposal.decision": input.decision.type,
      });
      if (userId === undefined) return yield* signInRequired;
      const decidable = loadProposal(input.threadId, input.proposalId).pipe(
        Effect.mapError(ledgerFailed),
        Effect.flatMap((loaded) =>
          loaded === null
            ? Effect.fail(notFound)
            : // A rolled-back turn's card is hidden; what it proposed is no longer on offer.
              loaded.run?.status === "rolled_back"
              ? Effect.fail(rolledBack)
              : Effect.succeed(loaded),
        ),
      );
      // Only a proposal that exists gets a lock.
      yield* decidable;
      return yield* exclusive(input.proposalId)(
        Effect.gen(function* () {
          const { item, run } = yield* decidable;
          // The card may have been recorded while its ledger row was not.
          yield* insertLedger({
            proposalId: item.id,
            threadId: item.threadId,
            proposal: item.proposal,
            run,
          });
          const row = yield* readLedger(item.id);
          if (row === null) return yield* ledgerFailed();
          if (input.decision.type === "reject") return yield* reject(userId, item);
          if (item.proposalStatus === "applied" || item.proposalStatus === "rejected") {
            return outcomeOf(item);
          }
          return yield* approve(userId, item, input.decision.proposal, row);
        }),
      );
    },
  );

  // ---- recovery -----------------------------------------------------------------------------

  /** Fails one approval no one is writing anymore and brings its card in line. */
  const recoverOne = (threadId: ThreadId, proposalId: string) =>
    Effect.gen(function* () {
      const row = yield* readLedger(proposalId);
      if (row === null) return;
      const loaded = yield* loadProposal(threadId, proposalId);
      const cardApproved = loaded?.item.proposalStatus === "approved";
      let settled = row;
      if (row.status === "approved" || (cardApproved && row.status === "pending")) {
        yield* settleLedger(proposalId, "failed", INTERRUPTED, unsaved.get(proposalId));
        unsaved.delete(proposalId);
        settled = (yield* readLedger(proposalId)) ?? row;
      }
      if (loaded !== null) yield* outcomeFromLedger(loaded.item, settled);
    });

  const recoverInterrupted: JiraProposals["Service"]["recoverInterrupted"] = Effect.gen(
    function* () {
      // Approvals the ledger holds, and cards still saying approved whatever the ledger says.
      const rows = yield* sql<{ readonly proposalId: string; readonly threadId: string }>`
        SELECT proposal.proposal_id AS "proposalId", proposal.thread_id AS "threadId"
        FROM fork_jira_proposals proposal
        WHERE proposal.status = 'approved'
          OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items item
            WHERE item.turn_item_id = proposal.proposal_id AND item.status = 'running'
          )
      `;
      yield* Effect.forEach(
        rows,
        (row) =>
          exclusive(row.proposalId)(recoverOne(ThreadId.make(row.threadId), row.proposalId)).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not recover an interrupted Jira approval", {
                proposalId: row.proposalId,
                errorTag: error._tag,
              }),
            ),
          ),
        { discard: true },
      );
    },
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not look for interrupted Jira approvals", { errorTag: error._tag }),
    ),
    Effect.withSpan("JiraProposals.recoverInterrupted"),
  );

  return JiraProposals.of({ propose, decide, recoverInterrupted });
});

export const layer = Layer.effect(JiraProposals, make);
