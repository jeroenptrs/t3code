/**
 * Fork-only software factories (docs/internals/software-factories.md). A factory's definition is
 * files in its owning project's checkout under `.t3/factories/<name>/`: `factory.json` and a
 * Markdown file per role. The database keeps only runtime state and never a prompt.
 */
import * as Schema from "effect/Schema";

import { AuthUserId } from "./authUser.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

const FACTORY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FACTORY_ID_PREFIX = "factory:";

/** The factory's directory under `.t3/factories/`: lowercase letters, digits, and hyphens. */
export const FactoryName = TrimmedNonEmptyString.check(
  Schema.isPattern(FACTORY_NAME_PATTERN),
  Schema.isMaxLength(64),
);
export type FactoryName = typeof FactoryName.Type;

/** `factory:<projectId>:<name>`, so the id follows from where the definition lives. */
export const FactoryId = TrimmedNonEmptyString.pipe(Schema.brand("FactoryId"));
export type FactoryId = typeof FactoryId.Type;

export const makeFactoryId = (projectId: ProjectId, name: FactoryName): FactoryId =>
  FactoryId.make(`${FACTORY_ID_PREFIX}${projectId}:${name}`);

const isProjectId = Schema.is(ProjectId);

/** The owning project and name in a factory id, or null when it is not one. */
export function parseFactoryId(
  id: string,
): { readonly projectId: ProjectId; readonly name: FactoryName } | null {
  if (!id.startsWith(FACTORY_ID_PREFIX)) return null;
  // Names have no colon, so the last one separates the project id, which may.
  const separator = id.lastIndexOf(":");
  const projectId = id.slice(FACTORY_ID_PREFIX.length, separator);
  const name = id.slice(separator + 1);
  if (!isProjectId(projectId) || !FACTORY_NAME_PATTERN.test(name) || name.length > 64) return null;
  return { projectId, name };
}

/** A skill's directory under `skills/`, named as the Agent Skills format requires. */
export const FactorySkillName = TrimmedNonEmptyString.check(
  Schema.isPattern(FACTORY_NAME_PATTERN),
  Schema.isMaxLength(64),
);
export type FactorySkillName = typeof FactorySkillName.Type;

export const FactoryRoleName = Schema.Literals(["foreman", "implement", "review"]);
export type FactoryRoleName = typeof FactoryRoleName.Type;

/** Where a role's agent works: the project's own checkout, or a worktree of its own. */
export const FactoryIsolation = Schema.Literals(["shared", "worktree"]);
export type FactoryIsolation = typeof FactoryIsolation.Type;

/** A role file's frontmatter. A binding the file leaves out takes the role's built-in default. */
export const FactoryRoleBinding = Schema.Struct({
  model: Schema.optionalKey(ModelSelection),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  isolation: Schema.optionalKey(FactoryIsolation),
  skills: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Tool names the role may call. Empty or absent means no allowlist. */
  tools: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type FactoryRoleBinding = typeof FactoryRoleBinding.Type;

/** A role's bindings once its file's are laid over the built-in default. */
export const FactoryEffectiveBinding = Schema.Struct({
  /** Null: the project's default model when the role's thread starts. */
  model: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  isolation: FactoryIsolation,
  skills: Schema.Array(TrimmedNonEmptyString),
  tools: Schema.Array(TrimmedNonEmptyString),
});
export type FactoryEffectiveBinding = typeof FactoryEffectiveBinding.Type;

/** Webhook triggers are scheduled tasks too, so this one kind covers both. */
export const FactoryTrigger = Schema.Struct({
  kind: Schema.Literal("scheduled_task"),
  scheduledTaskId: ScheduledTaskId,
});
export type FactoryTrigger = typeof FactoryTrigger.Type;

/** Relative to the factory directory, such as `roles/foreman.md`. No segment starts with a dot. */
export const FactoryRolePath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/),
  Schema.isMaxLength(256),
);
export type FactoryRolePath = typeof FactoryRolePath.Type;

/** `factory.json`. */
export const FactoryDefinition = Schema.Struct({
  name: FactoryName,
  /** T3 project names the factory may work in. The owning project is implied. */
  projects: Schema.Array(TrimmedNonEmptyString),
  triggers: Schema.Array(FactoryTrigger),
  /** The file for each role that has one. A role left out uses `roles/<role>.md` if it exists. */
  roles: Schema.Struct({
    foreman: Schema.optionalKey(FactoryRolePath),
    implement: Schema.optionalKey(FactoryRolePath),
    review: Schema.optionalKey(FactoryRolePath),
  }),
});
export type FactoryDefinition = typeof FactoryDefinition.Type;

export const FactoryRoleSource = Schema.Literals(["builtin", "file"]);
export type FactoryRoleSource = typeof FactoryRoleSource.Type;

export const FactorySkill = Schema.Struct({
  name: FactorySkillName,
  /** `file` when `skills/<name>/SKILL.md` exists, which replaces a built-in skill of that name. */
  source: FactoryRoleSource,
});
export type FactorySkill = typeof FactorySkill.Type;

export const FactoryRole = Schema.Struct({
  role: FactoryRoleName,
  /** Null when `factory.json` names no file for the role. */
  path: Schema.NullOr(FactoryRolePath),
  /** `file` when the role file was read; `builtin` when there is none or it is missing. */
  source: FactoryRoleSource,
  /** What the role file sets, for editing. Empty for a built-in role. */
  fileBinding: FactoryRoleBinding,
  binding: FactoryEffectiveBinding,
  /** The role's instructions: the file's body when it has one, else the built-in body. */
  body: Schema.String,
  bodySource: FactoryRoleSource,
  /** `binding.skills` that exist, in order. A name that does not is an `unknown_skill` issue. */
  skills: Schema.Array(FactorySkill),
});
export type FactoryRole = typeof FactoryRole.Type;

export const FactoryIssueCode = Schema.Literals([
  "invalid_definition",
  "name_mismatch",
  "unknown_project",
  "ambiguous_project",
  "unknown_scheduled_task",
  "missing_role_file",
  "invalid_role_file",
  "invalid_binding",
  "unknown_provider_instance",
  "unknown_model",
  "invalid_model_options",
  "unsupported_runtime_mode",
  "unknown_skill",
]);
export type FactoryIssueCode = typeof FactoryIssueCode.Type;

/** A problem in the definition. Reads report these; saves refuse the ones in role bindings. */
export const FactoryIssue = Schema.Struct({
  code: FactoryIssueCode,
  /** The role whose file has the problem; null for `factory.json`. */
  role: Schema.NullOr(FactoryRoleName),
  /** The field at fault, such as `model` or `projects`; null for the whole file. */
  field: Schema.NullOr(TrimmedNonEmptyString),
  message: Schema.String,
});
export type FactoryIssue = typeof FactoryIssue.Type;

export const FactoryAttention = Schema.Struct({
  /** Work items a gate holds for a person. */
  gatesWaiting: NonNegativeInt,
  /** Owned threads whose latest run failed, plus failed work items a person did not fail. */
  failedRuns: NonNegativeInt,
  /** Owned threads waiting on an answer from the user. */
  questions: NonNegativeInt,
  total: NonNegativeInt,
});
export type FactoryAttention = typeof FactoryAttention.Type;

export const FactoryThread = Schema.Struct({
  threadId: ThreadId,
  /**
   * The role the factory started it as, or the role it has on a work item; null for a thread an
   * owned scheduled task started, or a work item's thread with no role.
   */
  role: Schema.NullOr(FactoryRoleName),
});
export type FactoryThread = typeof FactoryThread.Type;

export const FactoryProject = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Null when no project here has that name, or more than one does. */
  projectId: Schema.NullOr(ProjectId),
});
export type FactoryProject = typeof FactoryProject.Type;

export const FactorySummary = Schema.Struct({
  id: FactoryId,
  projectId: ProjectId,
  name: FactoryName,
  issueCount: NonNegativeInt,
  /** What the factory owns. Both leave the home view for the factory's tab. */
  scheduledTaskIds: Schema.Array(ScheduledTaskId),
  threadIds: Schema.Array(ThreadId),
  attention: FactoryAttention,
});
export type FactorySummary = typeof FactorySummary.Type;

export const Factory = Schema.Struct({
  id: FactoryId,
  projectId: ProjectId,
  name: FactoryName,
  /** As read. Empty lists when `factory.json` is invalid; `issues` says why. */
  definition: FactoryDefinition,
  /** `definition.projects`, each with the project it names here. */
  projects: Schema.Array(FactoryProject),
  /** Foreman, implement, and review, in that order. */
  roles: Schema.Array(FactoryRole),
  /** Every skill a role here can name: the built-in ones and those under `skills/`, by name. */
  skills: Schema.Array(FactorySkill),
  issues: Schema.Array(FactoryIssue),
  scheduledTaskIds: Schema.Array(ScheduledTaskId),
  threads: Schema.Array(FactoryThread),
  attention: FactoryAttention,
});
export type Factory = typeof Factory.Type;

export const FactoryRoleFile = Schema.Struct({
  binding: FactoryRoleBinding,
  /** Null or blank keeps the built-in instructions. */
  body: Schema.NullOr(Schema.String.check(Schema.isMaxLength(65_536))),
});
export type FactoryRoleFile = typeof FactoryRoleFile.Type;

export const FactoryRoleChange = Schema.Struct({
  role: FactoryRoleName,
  /** Null deletes the role's file, so its built-in default applies. */
  file: Schema.NullOr(FactoryRoleFile),
});
export type FactoryRoleChange = typeof FactoryRoleChange.Type;

export const FactorySkillFile = Schema.Struct({
  /** The whole `SKILL.md`: frontmatter with `name` and `description`, then the instructions. */
  body: Schema.String.check(Schema.isMaxLength(65_536)),
});
export type FactorySkillFile = typeof FactorySkillFile.Type;

export const FactorySkillChange = Schema.Struct({
  name: FactorySkillName,
  /** Null deletes `skills/<name>/SKILL.md`, so a built-in skill of that name applies again. */
  file: Schema.NullOr(FactorySkillFile),
});
export type FactorySkillChange = typeof FactorySkillChange.Type;

/** Writes `factory.json` and the given role and skill files, creating the factory when it is new. */
export const FactorySaveInput = Schema.Struct({
  projectId: ProjectId,
  definition: FactoryDefinition,
  /** At most one change per role. A role left out keeps its file as it is. */
  roles: Schema.optionalKey(Schema.Array(FactoryRoleChange)),
  /** At most one change per skill. A skill left out keeps its files as they are. */
  skills: Schema.optionalKey(Schema.Array(FactorySkillChange)),
});
export type FactorySaveInput = typeof FactorySaveInput.Type;

export const FactoryListInput = Schema.Struct({
  /** Omit for every project in this environment. */
  projectId: Schema.optionalKey(ProjectId),
});
export type FactoryListInput = typeof FactoryListInput.Type;

export const FactoryListResult = Schema.Struct({
  factories: Schema.Array(FactorySummary),
});
export type FactoryListResult = typeof FactoryListResult.Type;

export const FactoryReadInput = Schema.Struct({
  factoryId: FactoryId,
});
export type FactoryReadInput = typeof FactoryReadInput.Type;

/**
 * - `not_found`: no factory with that id
 * - `project_not_found`: no project with that id
 * - `invalid`: a save was refused; `issues` says why
 * - `unavailable`: the files or the database could not be read or written
 */
export const FactoryErrorCode = Schema.Literals([
  "not_found",
  "project_not_found",
  "invalid",
  "unavailable",
]);
export type FactoryErrorCode = typeof FactoryErrorCode.Type;

export class FactoryError extends Schema.TaggedError<FactoryError>()("FactoryError", {
  code: FactoryErrorCode,
  message: Schema.String,
  issues: Schema.optionalKey(Schema.Array(FactoryIssue)),
}) {}

/** The Foreman's thread id starts with this, so clients can tell it apart. */
export const FACTORY_FOREMAN_THREAD_ID_PREFIX = "factory-foreman:";

/** `work-item:<uuid>`. */
export const WorkItemId = TrimmedNonEmptyString.pipe(Schema.brand("WorkItemId"));
export type WorkItemId = typeof WorkItemId.Type;

/** `waiting`: a gate holds the item for a person. `done`, `failed`, and `dropped` are terminal. */
export const WorkItemStage = Schema.Literals([
  "new",
  "implement",
  "review",
  "waiting",
  "done",
  "failed",
  "dropped",
]);
export type WorkItemStage = typeof WorkItemStage.Type;

/** Where a gate sends the item when the person approves. */
export const WorkItemResumeStage = Schema.Literals(["implement", "review", "done"]);
export type WorkItemResumeStage = typeof WorkItemResumeStage.Type;

/** What a person decides at a gate. */
export const WorkItemGateDecision = Schema.Literals(["approved", "rejected"]);
export type WorkItemGateDecision = typeof WorkItemGateDecision.Type;

/** `active` is every stage that is not terminal. */
export const WorkItemOutcome = Schema.Literals(["done", "failed", "dropped", "active"]);
export type WorkItemOutcome = typeof WorkItemOutcome.Type;

const WorkItemText = Schema.String.check(Schema.isMaxLength(65_536));
const WorkItemNote = Schema.String.check(Schema.isMaxLength(16_384));
const WorkItemTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/** `text` is the request. A scheduled task source is reserved for triggers and not created yet. */
export const WorkItemSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual"), text: WorkItemText }),
  Schema.Struct({
    kind: Schema.Literal("scheduled_task"),
    scheduledTaskId: ScheduledTaskId,
    deliveryId: Schema.NullOr(TrimmedNonEmptyString),
    text: WorkItemText,
  }),
]);
export type WorkItemSource = typeof WorkItemSource.Type;

export const WorkItemGate = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({
    state: Schema.Literal("waiting"),
    question: WorkItemNote,
    resumeStage: WorkItemResumeStage,
    askedAt: IsoDateTime,
  }),
  Schema.Struct({
    state: Schema.Literal("answered"),
    question: WorkItemNote,
    decision: WorkItemGateDecision,
    note: WorkItemNote,
    answeredAt: IsoDateTime,
    resumeStage: WorkItemResumeStage,
  }),
]);
export type WorkItemGate = typeof WorkItemGate.Type;

export const WorkItemActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("foreman"), threadId: ThreadId }),
  /** Null for a session with no user, such as the admin dev credential. */
  Schema.Struct({ kind: Schema.Literal("user"), userId: Schema.NullOr(AuthUserId) }),
  Schema.Struct({ kind: Schema.Literal("server") }),
]);
export type WorkItemActor = typeof WorkItemActor.Type;

export const WorkItemTransition = Schema.Struct({
  id: TrimmedNonEmptyString,
  from: WorkItemStage,
  to: WorkItemStage,
  actor: WorkItemActor,
  note: Schema.NullOr(WorkItemNote),
  at: IsoDateTime,
});
export type WorkItemTransition = typeof WorkItemTransition.Type;

/** A thread that worked on the item, with the role it worked as; null when it had none. */
export const WorkItemThread = Schema.Struct({
  threadId: ThreadId,
  role: Schema.NullOr(FactoryRoleName),
});
export type WorkItemThread = typeof WorkItemThread.Type;

export const WorkItemSummary = Schema.Struct({
  id: WorkItemId,
  factoryId: FactoryId,
  title: WorkItemTitle,
  source: WorkItemSource,
  stage: WorkItemStage,
  gate: WorkItemGate,
  /** Null until the Foreman thread is known. */
  foremanThreadId: Schema.NullOr(ThreadId),
  /** The Foreman run the item was sent as; null until it was sent. */
  foremanRunId: Schema.NullOr(RunId),
  /**
   * When the server sent the item to its Foreman. Null while it waits for the factory's active
   * item to end, and on an item that was never sent.
   */
  dispatchedAt: Schema.NullOr(IsoDateTime),
  threads: Schema.Array(WorkItemThread),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkItemSummary = typeof WorkItemSummary.Type;

export const WorkItem = Schema.Struct({
  ...WorkItemSummary.fields,
  /** Oldest first. */
  transitions: Schema.Array(WorkItemTransition),
});
export type WorkItem = typeof WorkItem.Type;

const TERMINAL_WORK_ITEM_STAGES: ReadonlySet<WorkItemStage> = new Set([
  "done",
  "failed",
  "dropped",
]);

export const isTerminalWorkItemStage = (stage: WorkItemStage): boolean =>
  TERMINAL_WORK_ITEM_STAGES.has(stage);

const NEXT_WORK_ITEM_STAGES = {
  new: ["implement", "waiting", "dropped", "failed"],
  implement: ["review", "waiting", "failed", "dropped"],
  review: ["implement", "done", "waiting", "failed"],
  // Plus the stage the waiting gate resumes to.
  waiting: ["dropped", "failed"],
  done: [],
  failed: [],
  dropped: [],
} satisfies Record<WorkItemStage, ReadonlyArray<WorkItemStage>>;

/** Whether an item at `from` may move to `to`. Out of `waiting`, the gate's resume stage too. */
export function canTransitionWorkItem(
  from: WorkItemStage,
  to: WorkItemStage,
  gate: WorkItemGate,
): boolean {
  if (from === "waiting" && gate.state === "waiting" && to === gate.resumeStage) return true;
  return (NEXT_WORK_ITEM_STAGES[from] as ReadonlyArray<WorkItemStage>).includes(to);
}

export const WorkItemListInput = Schema.Struct({
  factoryId: FactoryId,
  stage: Schema.optionalKey(WorkItemStage),
  /** Items with a thread in this role. */
  role: Schema.optionalKey(FactoryRoleName),
  outcome: Schema.optionalKey(WorkItemOutcome),
});
export type WorkItemListInput = typeof WorkItemListInput.Type;

export const WorkItemListResult = Schema.Struct({
  /** Newest first, at most 200. */
  workItems: Schema.Array(WorkItemSummary),
});
export type WorkItemListResult = typeof WorkItemListResult.Type;

export const WorkItemReadInput = Schema.Struct({
  workItemId: WorkItemId,
});
export type WorkItemReadInput = typeof WorkItemReadInput.Type;

export const WorkItemCreateInput = Schema.Struct({
  factoryId: FactoryId,
  title: WorkItemTitle,
  /** The request, as the Foreman reads it. */
  text: WorkItemText.check(Schema.isMinLength(1)),
});
export type WorkItemCreateInput = typeof WorkItemCreateInput.Type;

export const WorkItemAnswerGateInput = Schema.Struct({
  workItemId: WorkItemId,
  decision: WorkItemGateDecision,
  note: WorkItemNote,
});
export type WorkItemAnswerGateInput = typeof WorkItemAnswerGateInput.Type;

/** Stages the Foreman moves an item to. `waiting` takes a gate instead. */
export const WorkItemAdvanceStage = Schema.Literals([
  "implement",
  "review",
  "done",
  "failed",
  "dropped",
]);
export type WorkItemAdvanceStage = typeof WorkItemAdvanceStage.Type;

export const WorkItemAdvanceInput = Schema.Struct({
  workItemId: WorkItemId,
  stage: WorkItemAdvanceStage,
  note: Schema.optionalKey(WorkItemNote),
  threads: Schema.optionalKey(Schema.Array(WorkItemThread)),
});
export type WorkItemAdvanceInput = typeof WorkItemAdvanceInput.Type;

export const WorkItemGateInput = Schema.Struct({
  workItemId: WorkItemId,
  question: WorkItemNote.check(Schema.isMinLength(1)),
  resumeStage: WorkItemResumeStage,
});
export type WorkItemGateInput = typeof WorkItemGateInput.Type;

/**
 * `not_foreman`: only the item's Foreman thread may do this. `gate_waiting`: only a person's
 * answer moves the item on. `no_gate`: no gate waits for an answer. `unavailable`: the database
 * or the Foreman thread could not be reached.
 */
export const WorkItemErrorCode = Schema.Literals([
  "not_found",
  "not_foreman",
  "gate_waiting",
  "no_gate",
  "unavailable",
]);
export type WorkItemErrorCode = typeof WorkItemErrorCode.Type;

export class WorkItemError extends Schema.TaggedError<WorkItemError>()("WorkItemError", {
  code: WorkItemErrorCode,
  message: Schema.String,
}) {}

export class WorkItemTransitionError extends Schema.TaggedError<WorkItemTransitionError>()(
  "WorkItemTransitionError",
  { workItemId: WorkItemId, from: WorkItemStage, to: WorkItemStage },
) {
  override get message(): string {
    return `Work item ${this.workItemId} cannot move from ${this.from} to ${this.to}.`;
  }
}
