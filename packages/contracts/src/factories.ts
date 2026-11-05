/**
 * Fork-only software factories (docs/internals/software-factories.md). A factory's definition is
 * files in its owning project's checkout under `.t3/factories/<name>/`: `factory.json` and a
 * Markdown file per role. The database keeps only runtime state and never a prompt.
 */
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  ProjectId,
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
  /** The file for each role that has one. A role left out uses its built-in default. */
  roles: Schema.Struct({
    foreman: Schema.optionalKey(FactoryRolePath),
    implement: Schema.optionalKey(FactoryRolePath),
    review: Schema.optionalKey(FactoryRolePath),
  }),
});
export type FactoryDefinition = typeof FactoryDefinition.Type;

export const FactoryRoleSource = Schema.Literals(["builtin", "file"]);
export type FactoryRoleSource = typeof FactoryRoleSource.Type;

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
  /** Always 0 until factories have gates. */
  gatesWaiting: NonNegativeInt,
  /** Owned threads whose latest run failed. */
  failedRuns: NonNegativeInt,
  /** Owned threads waiting on an answer from the user. */
  questions: NonNegativeInt,
  total: NonNegativeInt,
});
export type FactoryAttention = typeof FactoryAttention.Type;

export const FactoryThread = Schema.Struct({
  threadId: ThreadId,
  /** The role the factory started it as; null for a thread an owned scheduled task started. */
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

/** Writes `factory.json` and the given role files, creating the factory when it is new. */
export const FactorySaveInput = Schema.Struct({
  projectId: ProjectId,
  definition: FactoryDefinition,
  /** At most one change per role. A role left out keeps its file as it is. */
  roles: Schema.optionalKey(Schema.Array(FactoryRoleChange)),
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
