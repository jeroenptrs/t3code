/**
 * Fork-only software factories (docs/internals/factories.md). Reads and writes each factory's
 * definition files in its project's checkout, reports what the factory owns and what of that
 * needs a person, keeps the work item ledger, and launches each work item's own Foreman thread.
 */
import {
  type AuthUserId,
  canTransitionWorkItem,
  CommandId,
  FACTORY_FOREMAN_ROLE,
  FACTORY_FOREMAN_THREAD_ID_PREFIX,
  type Factory,
  type FactoryAttention,
  type FactoryDefinition,
  type FactoryDeleteResult,
  FactoryError,
  FactoryId,
  type FactoryIssue,
  type FactoryListResult,
  FactoryName,
  type FactoryProject,
  type FactoryRole,
  FactoryRoleName,
  type FactoryRolePath,
  type FactoryRolePreset,
  type FactorySaveInput,
  type FactorySkill,
  type FactoryThread,
  isTerminalWorkItemStage,
  makeFactoryId,
  MessageId,
  type OrchestratorMcpDelegateTaskInput,
  parseFactoryId,
  type ProjectId,
  RunId,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
  type WorkItem,
  type WorkItemActor,
  WorkItemActor as WorkItemActorSchema,
  type WorkItemAdvanceInput,
  type WorkItemAnswerGateInput,
  type WorkItemCreateInput,
  type WorkItemDismissFailureInput,
  type WorkItemDropInput,
  WorkItemError,
  WorkItemGate,
  type WorkItemGateInput,
  WorkItemId,
  type WorkItemListResult,
  type WorkItemOutcome,
  WorkItemSource,
  type WorkItemTriggerSource,
  WorkItemStage,
  type WorkItemSummary,
  type WorkItemThread,
  WorkItemTransitionError,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  bindingIssues,
  defaultRolePath,
  effectiveBinding,
  FACTORIES_DIRECTORY,
  FACTORY_FILE_NAME,
  factoryRoleNames,
  readFactoryFiles,
  renderFactoryJson,
  renderRoleFile,
  resolveProjects,
  resolveRoleSkills,
  roleEnabled,
  type RoleFileEntry,
  roleNameProblem,
  toFactorySkill,
} from "./factoryFiles.ts";
import * as FactorySkillStore from "./FactorySkillStore.ts";
import { roleDefaults, rolePresets } from "./roles/index.ts";
import {
  bindDelegation,
  renderDropMessage,
  renderGateAnswerMessage,
  renderWorkItemMessage,
} from "./workItems.ts";

const ROLE_PRESETS: ReadonlyArray<FactoryRolePreset> = Object.entries(rolePresets).map(
  ([name, preset]) => ({ name, binding: preset.binding, body: preset.body }),
);
const isFactoryName = Schema.is(FactoryName);
const isRoleName = Schema.is(FactoryRoleName);
const isWorkItemStage = Schema.is(WorkItemStage);

export class FactoryService extends Context.Service<
  FactoryService,
  {
    /** Every factory in this environment's projects, or in one project. */
    readonly list: (projectId?: ProjectId) => Effect.Effect<FactoryListResult, FactoryError>;
    readonly read: (factoryId: FactoryId) => Effect.Effect<Factory, FactoryError>;
    /** Refuses invalid role bindings; names and role paths are already checked by the schema. */
    readonly save: (input: FactorySaveInput) => Effect.Effect<Factory, FactoryError>;
    /**
     * Removes the factory's directory and its work items, and returns its threads to Home. Its
     * scheduled tasks stay.
     */
    readonly delete: (factoryId: FactoryId) => Effect.Effect<FactoryDeleteResult, FactoryError>;
    /** Newest first, at most 200. Without a factory, every factory's. */
    readonly listWorkItems: (
      filter: WorkItemFilter,
    ) => Effect.Effect<WorkItemListResult, WorkItemError>;
    readonly readWorkItem: (workItemId: WorkItemId) => Effect.Effect<WorkItem, WorkItemError>;
    /**
     * Records the item at `new` and launches its own Foreman thread with the item as the first
     * message. An item that cannot be started stays on record as failed, and the error comes back.
     */
    readonly createWorkItem: (
      input: WorkItemCreateInput,
    ) => Effect.Effect<WorkItem, FactoryError | WorkItemError>;
    /** `createWorkItem` for a trigger's run, with the trigger and its event as the source. */
    readonly createWorkItemFromTrigger: (input: {
      readonly factoryId: FactoryId;
      readonly title: string;
      readonly source: WorkItemTriggerSource;
    }) => Effect.Effect<WorkItem, FactoryError | WorkItemError>;
    /** The item's Foreman ends it: done, failed, or dropped. */
    readonly advanceWorkItem: (
      callerThreadId: ThreadId,
      input: WorkItemAdvanceInput,
    ) => Effect.Effect<WorkItem, WorkItemError | WorkItemTransitionError>;
    /** The item's Foreman holds it for a person. */
    readonly gateWorkItem: (
      callerThreadId: ThreadId,
      input: WorkItemGateInput,
    ) => Effect.Effect<WorkItem, WorkItemError | WorkItemTransitionError>;
    /** Records a person's answer, then tells the item's Foreman thread. A rejection ends it. */
    readonly answerWorkItemGate: (
      userId: AuthUserId | null,
      input: WorkItemAnswerGateInput,
    ) => Effect.Effect<WorkItem, WorkItemError | WorkItemTransitionError>;
    /**
     * A person dismisses a failed item's failure, so it stops asking for attention, or restores
     * it. The item stays failed, and its log records who did it.
     */
    readonly setWorkItemFailureDismissed: (
      userId: AuthUserId | null,
      input: WorkItemDismissFailureInput,
    ) => Effect.Effect<WorkItem, WorkItemError>;
    /**
     * A person drops an item that has not ended, then its Foreman thread is told to stop. The
     * item's log records who dropped it.
     */
    readonly dropWorkItem: (
      userId: AuthUserId | null,
      input: WorkItemDropInput,
    ) => Effect.Effect<WorkItem, WorkItemError | WorkItemTransitionError>;
    /**
     * Starts every item at `new` that has no Foreman thread yet, such as one a restart left
     * between insert and launch. A repeat is harmless. The layer forks this when it starts.
     */
    readonly dispatchPending: Effect.Effect<void>;
    /**
     * Binds a Foreman's delegation to the enabled role it names, moves its item to `working`, and
     * names the child on the item before the child exists. Refuses no role or an unusable one, and
     * gates the first child on a Git identity. Other threads' calls come back as they are.
     */
    readonly prepareDelegation: (input: {
      readonly parentThreadId: ThreadId;
      /** The delegation's command, from which the child's thread id derives. */
      readonly commandId: CommandId;
      readonly delegation: FactoryDelegation;
      /** What `t3_factory_delegate` names; null for a plain `delegate_task`. */
      readonly factoryRole: FactoryDelegationRole | null;
    }) => Effect.Effect<FactoryDelegation, FactoryError | WorkItemError>;
  }
>()("t3/factories/FactoryService") {}

export type FactoryDelegation = OrchestratorMcpDelegateTaskInput;

/**
 * What `t3_factory_delegate` names for the `delegate_task` path it runs: the work item and the
 * role the child runs as. Null for a plain `delegate_task`, so upstream's signature stays as is.
 */
export const FactoryDelegationRole = Context.Reference<{
  readonly workItemId: WorkItemId;
  readonly role: FactoryRoleName;
} | null>("t3/factories/FactoryDelegationRole", { defaultValue: () => null });
export type FactoryDelegationRole = NonNullable<typeof FactoryDelegationRole.Service>;

export interface WorkItemFilter {
  readonly factoryId?: FactoryId | undefined;
  readonly stage?: WorkItemStage | undefined;
  readonly role?: FactoryRoleName | undefined;
  readonly outcome?: WorkItemOutcome | undefined;
}

const WORK_ITEM_LIST_LIMIT = 200;

const WorkItemRow = Schema.Struct({
  id: WorkItemId,
  factoryId: FactoryId,
  title: Schema.String,
  source: Schema.fromJsonString(WorkItemSource),
  stage: WorkItemStage,
  gate: Schema.fromJsonString(WorkItemGate),
  foremanThreadId: Schema.NullOr(ThreadId),
  foremanRunId: Schema.NullOr(RunId),
  dispatchedAt: Schema.NullOr(Schema.String),
  failureDismissedAt: Schema.NullOr(Schema.String),
  failedByUser: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const decodeWorkItemRows = Schema.decodeUnknownEffect(Schema.Array(WorkItemRow));

const WorkItemTransitionRow = Schema.Struct({
  id: Schema.String,
  workItemId: WorkItemId,
  from: WorkItemStage,
  to: WorkItemStage,
  actor: Schema.fromJsonString(WorkItemActorSchema),
  note: Schema.NullOr(Schema.String),
  at: Schema.String,
});
const decodeTransitionRows = Schema.decodeUnknownEffect(Schema.Array(WorkItemTransitionRow));
const encodeSource = Schema.encodeEffect(Schema.fromJsonString(WorkItemSource));
const encodeGate = Schema.encodeEffect(Schema.fromJsonString(WorkItemGate));
const encodeActor = Schema.encodeEffect(Schema.fromJsonString(WorkItemActorSchema));

const workItemNotFound = (workItemId: WorkItemId) =>
  new WorkItemError({ code: "not_found", message: `No work item ${workItemId} exists here.` });

const workItemUnavailable =
  (message: string) =>
  <E>(cause: E) =>
    Effect.logWarning(message, cause).pipe(
      Effect.andThen(Effect.fail(new WorkItemError({ code: "unavailable", message }))),
    );

type ProjectRow = ProjectStore.ProjectRow;

/** A factory as its files say, before what it owns is looked up. */
interface LoadedFactory {
  readonly id: FactoryId;
  readonly project: ProjectRow;
  readonly name: FactoryName;
  readonly definition: FactoryDefinition;
  readonly roles: ReadonlyArray<FactoryRole>;
  readonly skills: ReadonlyArray<FactorySkill>;
  readonly issues: ReadonlyArray<FactoryIssue>;
}

interface Catalog {
  readonly projects: ReadonlyArray<ProjectRow>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly scheduledTaskIds: ReadonlySet<ScheduledTaskId>;
}

interface OwnedView {
  readonly factory: LoadedFactory;
  readonly projects: ReadonlyArray<FactoryProject>;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly scheduledTaskIds: ReadonlyArray<ScheduledTaskId>;
  readonly threads: ReadonlyArray<FactoryThread>;
  readonly attention: FactoryAttention;
}

const notFound = (factoryId: string) =>
  new FactoryError({ code: "not_found", message: `No factory ${factoryId} exists here.` });

const unavailable =
  (operation: "read" | "written") =>
  <E>(cause: E) =>
    Effect.logWarning(`Factories could not be ${operation}.`, cause).pipe(
      Effect.andThen(
        Effect.fail(
          new FactoryError({
            code: "unavailable",
            message: `Factories could not be ${operation}.`,
          }),
        ),
      ),
    );

/** A role as its file lays over its defaults, and what is wrong with it. */
function resolveRole(
  { role, path: rolePath, file }: RoleFileEntry,
  providers: ReadonlyArray<ServerProvider>,
  skills: ReadonlyArray<FactorySkill>,
): { readonly role: FactoryRole; readonly issues: ReadonlyArray<FactoryIssue> } {
  const defaults = roleDefaults(role);
  if (file === null) {
    const resolved = resolveRoleSkills(role, defaults.binding.skills, skills);
    return {
      role: {
        role,
        path: rolePath,
        source: "builtin",
        fileBinding: {},
        binding: defaults.binding,
        enabled: true,
        body: defaults.body,
        bodySource: "builtin",
        skills: resolved.skills,
      },
      issues:
        rolePath === null
          ? resolved.issues
          : [
              {
                code: "missing_role_file",
                role,
                field: null,
                message: `${rolePath} does not exist, so ${role} uses its defaults.`,
              },
              ...resolved.issues,
            ],
    };
  }
  const binding = effectiveBinding(defaults.binding, file.binding);
  const resolved = resolveRoleSkills(role, binding.skills, skills);
  const enabled = roleEnabled(role, file.binding);
  return {
    role: {
      role,
      path: rolePath,
      source: "file",
      fileBinding: file.binding,
      binding,
      enabled: enabled.enabled,
      body: file.body ?? defaults.body,
      bodySource: file.body === null ? "builtin" : "file",
      skills: resolved.skills,
    },
    issues: [
      ...file.issues,
      ...(enabled.issue === null ? [] : [enabled.issue]),
      ...bindingIssues(role, binding, providers),
      ...resolved.issues,
    ],
  };
}

/** The roles a Foreman can delegate to: the enabled ones besides itself. */
const delegateRoles = (factory: Factory) =>
  factory.roles
    .filter((role) => role.role !== FACTORY_FOREMAN_ROLE && role.enabled)
    .map((role) => role.role);

/** Why `role` cannot work an item of `factory` now, or null when it can. */
function roleProblem(factory: Factory, role: string, verb: string): WorkItemError | null {
  const usable = delegateRoles(factory);
  const roles = `Roles you can ${verb}: ${usable.length === 0 ? "none" : usable.join(", ")}.`;
  const found =
    role === FACTORY_FOREMAN_ROLE ? undefined : factory.roles.find((r) => r.role === role);
  if (found === undefined) {
    return new WorkItemError({
      code: "unknown_role",
      message: `The ${factory.name} factory has no role ${role} to work an item. ${roles}`,
    });
  }
  if (!found.enabled) {
    return new WorkItemError({
      code: "role_disabled",
      message: `The ${role} role is disabled in the ${factory.name} factory. ${roles}`,
    });
  }
  return null;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const skillStore = yield* FactorySkillStore.FactorySkillStore;
  // Serializes a factory's stage changes, dispatches, and deletion, so a dispatch sees whether its
  // item was already started and a delete never races a launch.
  const ledgerLocks = yield* KeyedLock.make<FactoryId>();

  const factoryDirectory = (project: ProjectRow, name: FactoryName) =>
    path.join(project.workspaceRoot, ...FACTORIES_DIRECTORY, name);

  const loadCatalog = Effect.gen(function* () {
    const projects = yield* projectStore.list();
    const providers = yield* providerRegistry.getProviders;
    const { tasks } = yield* scheduledTasks.list();
    return {
      projects,
      providers,
      scheduledTaskIds: new Set(tasks.map((task) => task.id)),
    } satisfies Catalog;
  }).pipe(Effect.catch(unavailable("read")));

  const loadFactory = Effect.fn("FactoryService.loadFactory")(function* (
    project: ProjectRow,
    name: FactoryName,
    providers: ReadonlyArray<ServerProvider>,
  ) {
    const directory = factoryDirectory(project, name);
    const files = yield* readFactoryFiles(fileSystem, path, directory, name);
    if (Option.isNone(files)) return Option.none<LoadedFactory>();
    const { definition, issues } = files.value;
    const skills = (yield* skillStore.resolve(directory)).map(toFactorySkill);
    const roles = files.value.roles.map((entry) => resolveRole(entry, providers, skills));
    return Option.some<LoadedFactory>({
      id: makeFactoryId(project.projectId, name),
      project,
      name,
      definition,
      roles: roles.map((loaded) => loaded.role),
      skills,
      issues: [...issues, ...roles.flatMap((loaded) => loaded.issues)],
    });
  });

  const scanProject = Effect.fn("FactoryService.scanProject")(
    function* (project: ProjectRow, providers: ReadonlyArray<ServerProvider>) {
      const entries = yield* fileSystem
        .readDirectoryEntries(path.join(project.workspaceRoot, ...FACTORIES_DIRECTORY))
        .pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
          }),
        );
      const names = entries
        .filter((entry) => entry.type !== "File" && isFactoryName(entry.name))
        .map((entry) => entry.name)
        .toSorted();
      const loaded = yield* Effect.forEach(names, (name) => loadFactory(project, name, providers));
      return loaded.flatMap(Option.toArray);
    },
    // One unreadable checkout must not hide every other project's factories.
    (effect, project) =>
      effect.pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.logWarning("Skipped a project whose factories could not be read.", error).pipe(
              Effect.annotateLogs({ projectId: project.projectId }),
              Effect.as([]),
            ),
        }),
      ),
  );

  /**
   * Owned threads: those the factory started for a role, those its work items name, and those
   * its scheduled tasks sent work into, which their messages record. Deleted threads are left out.
   */
  const loadOwnership = Effect.fn("FactoryService.loadOwnership")(function* (
    factories: ReadonlyArray<LoadedFactory>,
    catalog: Catalog,
  ) {
    const taskIdsOf = (factory: LoadedFactory) => [
      ...new Set(
        factory.definition.triggers
          .map((trigger) => trigger.scheduledTaskId)
          .filter((taskId) => catalog.scheduledTaskIds.has(taskId)),
      ),
    ];
    const factoryIds = factories.map((factory) => factory.id);
    const taskIds = [...new Set(factories.flatMap(taskIdsOf))];
    const roleRows =
      factoryIds.length === 0
        ? []
        : yield* sql<{
            readonly factoryId: string;
            readonly threadId: string;
            readonly role: string;
          }>`
            SELECT f.factory_id AS "factoryId", f.thread_id AS "threadId", f.role
            FROM fork_factory_threads f
            JOIN orchestration_v2_projection_threads t
              ON t.thread_id = f.thread_id AND t.deleted_at IS NULL
            WHERE f.factory_id IN ${sql.in(factoryIds)}
            ORDER BY f.created_at, f.thread_id
          `.pipe(NodeSqliteClient.readOnly);
    const workItemThreadRows =
      factoryIds.length === 0
        ? []
        : yield* sql<{
            readonly factoryId: string;
            readonly threadId: string;
            readonly role: string | null;
          }>`
            SELECT w.factory_id AS "factoryId", t.thread_id AS "threadId", t.role
            FROM fork_factory_work_item_threads t
            JOIN fork_factory_work_items w ON w.work_item_id = t.work_item_id
            JOIN orchestration_v2_projection_threads p
              ON p.thread_id = t.thread_id AND p.deleted_at IS NULL
            WHERE w.factory_id IN ${sql.in(factoryIds)}
            ORDER BY t.created_at, t.rowid
          `.pipe(NodeSqliteClient.readOnly);
    const waitingCounts =
      factoryIds.length === 0
        ? []
        : yield* sql<{ readonly factoryId: string; readonly waiting: number }>`
            SELECT w.factory_id AS "factoryId", COUNT(*) AS waiting
            FROM fork_factory_work_items w
            WHERE w.factory_id IN ${sql.in(factoryIds)} AND w.stage = 'waiting'
            GROUP BY w.factory_id
          `.pipe(NodeSqliteClient.readOnly);
    // A failed item asks for attention unless a person failed it, as a rejected gate would, or
    // dismissed the failure. Its run thread is checked against the shells below.
    const failedItems =
      factoryIds.length === 0
        ? []
        : yield* sql<{ readonly factoryId: string; readonly foremanThreadId: string | null }>`
            SELECT w.factory_id AS "factoryId", w.foreman_thread_id AS "foremanThreadId"
            FROM fork_factory_work_items w
            WHERE w.factory_id IN ${sql.in(factoryIds)}
              AND w.stage = 'failed'
              AND w.failure_dismissed_at IS NULL
              AND COALESCE((
                SELECT json_extract(t.actor_json, '$.kind')
                FROM fork_factory_work_item_transitions t
                WHERE t.work_item_id = w.work_item_id
                  AND t.to_stage = 'failed' AND t.from_stage <> 'failed'
                ORDER BY t.at DESC, t.rowid DESC
                LIMIT 1
              ), '') <> 'user'
          `.pipe(NodeSqliteClient.readOnly);
    // idx_fork_messages_scheduled_task (fork migration 016) serves this lookup.
    const taskRows =
      taskIds.length === 0
        ? []
        : yield* sql<{ readonly scheduledTaskId: string; readonly threadId: string }>`
            SELECT
              json_extract(m.payload_json, '$.scheduledTaskId') AS "scheduledTaskId",
              m.thread_id AS "threadId",
              MIN(t.created_at) AS "createdAt"
            FROM orchestration_v2_projection_messages m
            JOIN orchestration_v2_projection_threads t
              ON t.thread_id = m.thread_id AND t.deleted_at IS NULL
            WHERE json_extract(m.payload_json, '$.scheduledTaskId') IN ${sql.in(taskIds)}
            GROUP BY 1, 2
            ORDER BY 3, 2
          `.pipe(NodeSqliteClient.readOnly);

    const owned = factories.map((factory) => {
      const scheduledTaskIds = taskIdsOf(factory);
      const threads = new Map<ThreadId, FactoryThread>();
      for (const row of roleRows) {
        if (row.factoryId !== factory.id) continue;
        const threadId = ThreadId.make(row.threadId);
        threads.set(threadId, { threadId, role: isRoleName(row.role) ? row.role : null });
      }
      for (const row of workItemThreadRows) {
        if (row.factoryId !== factory.id) continue;
        const threadId = ThreadId.make(row.threadId);
        if (threads.has(threadId)) continue;
        threads.set(threadId, { threadId, role: isRoleName(row.role) ? row.role : null });
      }
      for (const row of taskRows) {
        const threadId = ThreadId.make(row.threadId);
        if (threads.has(threadId)) continue;
        if (!scheduledTaskIds.includes(ScheduledTaskId.make(row.scheduledTaskId))) continue;
        threads.set(threadId, { threadId, role: null });
      }
      return { factory, scheduledTaskIds, threads: [...threads.values()] };
    });

    const threadIds = [
      ...new Set([
        ...owned.flatMap(({ threads }) => threads.map((t) => t.threadId)),
        ...failedItems.flatMap((item) =>
          item.foremanThreadId === null ? [] : [ThreadId.make(item.foremanThreadId)],
        ),
      ]),
    ];
    const shells =
      threadIds.length === 0
        ? []
        : (yield* threadManagement.getShellSnapshot({ location: "active", threadIds })).threads;
    const shellById = new Map(shells.map((shell) => [shell.id, shell]));

    return owned.map(({ factory, scheduledTaskIds, threads }): OwnedView => {
      const gatesWaiting = waitingCounts.find((row) => row.factoryId === factory.id)?.waiting ?? 0;
      // A run thread that is settled, archived, or deleted means the failure is done with. An
      // item whose run never started has no thread to settle, so it keeps counting.
      let failedRuns = 0;
      for (const item of failedItems) {
        if (item.factoryId !== factory.id) continue;
        if (item.foremanThreadId === null) {
          failedRuns += 1;
          continue;
        }
        const shell = shellById.get(ThreadId.make(item.foremanThreadId));
        if (shell !== undefined && shell.settledOverride !== "settled") failedRuns += 1;
      }
      let questions = 0;
      for (const { threadId } of threads) {
        const shell = shellById.get(threadId);
        if (shell === undefined || shell.settledOverride === "settled") continue;
        if (shell.status === "failed") failedRuns += 1;
        if (shell.pendingRuntimeRequest?.kind === "user_input") questions += 1;
      }
      const resolved = resolveProjects(factory.definition.projects, catalog.projects);
      const unknownTasks = factory.definition.triggers.filter(
        (trigger) => !catalog.scheduledTaskIds.has(trigger.scheduledTaskId),
      );
      return {
        factory,
        projects: resolved.projects,
        issues: [
          ...factory.issues,
          ...resolved.issues,
          ...unknownTasks.map((trigger): FactoryIssue => ({
            code: "unknown_scheduled_task",
            role: null,
            field: "triggers",
            message: `No scheduled task ${trigger.scheduledTaskId} exists here.`,
          })),
        ],
        scheduledTaskIds,
        threads,
        attention: {
          gatesWaiting,
          failedRuns,
          questions,
          total: gatesWaiting + failedRuns + questions,
        },
      };
    });
  });

  const withOwnership = (factories: ReadonlyArray<LoadedFactory>, catalog: Catalog) =>
    loadOwnership(factories, catalog).pipe(Effect.catch(unavailable("read")));

  const list = Effect.fn("FactoryService.list")(function* (projectId?: ProjectId) {
    const catalog = yield* loadCatalog;
    const scanned =
      projectId === undefined
        ? catalog.projects
        : catalog.projects.filter((project) => project.projectId === projectId);
    if (projectId !== undefined && scanned.length === 0) {
      return yield* new FactoryError({
        code: "project_not_found",
        message: `No project ${projectId} exists here.`,
      });
    }
    const factories = yield* Effect.forEach(scanned, (project) =>
      scanProject(project, catalog.providers),
    );
    const views = yield* withOwnership(factories.flat(), catalog);
    return {
      factories: views.map((view) => ({
        id: view.factory.id,
        projectId: view.factory.project.projectId,
        name: view.factory.name,
        issueCount: view.issues.length,
        scheduledTaskIds: view.scheduledTaskIds,
        threadIds: view.threads.map((thread) => thread.threadId),
        attention: view.attention,
      })),
    } satisfies FactoryListResult;
  });

  const read = Effect.fn("FactoryService.read")(function* (factoryId: FactoryId) {
    const parsed = parseFactoryId(factoryId);
    if (parsed === null) return yield* notFound(factoryId);
    const catalog = yield* loadCatalog;
    const project = catalog.projects.find((candidate) => candidate.projectId === parsed.projectId);
    if (project === undefined) return yield* notFound(factoryId);
    const loaded = yield* loadFactory(project, parsed.name, catalog.providers).pipe(
      Effect.catch(unavailable("read")),
    );
    if (Option.isNone(loaded)) return yield* notFound(factoryId);
    const [view] = yield* withOwnership([loaded.value], catalog);
    if (view === undefined) return yield* notFound(factoryId);
    return {
      id: view.factory.id,
      projectId: view.factory.project.projectId,
      name: view.factory.name,
      definition: view.factory.definition,
      projects: view.projects,
      roles: view.factory.roles,
      rolePresets: ROLE_PRESETS,
      skills: view.factory.skills,
      issues: view.issues,
      scheduledTaskIds: view.scheduledTaskIds,
      threads: view.threads,
      attention: view.attention,
    } satisfies Factory;
  });

  const save = Effect.fn("FactoryService.save")(function* (input: FactorySaveInput) {
    const catalog = yield* loadCatalog;
    const project = catalog.projects.find((candidate) => candidate.projectId === input.projectId);
    if (project === undefined) {
      return yield* new FactoryError({
        code: "project_not_found",
        message: `No project ${input.projectId} exists here.`,
      });
    }

    const directory = factoryDirectory(project, input.definition.name);
    const issues: Array<FactoryIssue> = [];
    const savedSkills = yield* skillStore
      .resolve(directory)
      .pipe(Effect.catch(unavailable("read")));

    for (const role of Object.keys(input.definition.roles)) {
      const problem = roleNameProblem(role);
      if (problem !== null) {
        issues.push({ code: "invalid_definition", role: null, field: "roles", message: problem });
      }
    }
    const listed = new Set<string>(factoryRoleNames(input.definition));
    // A role the save removes keeps the path the file on disk gave it, so its file can go.
    const previous = yield* readFactoryFiles(
      fileSystem,
      path,
      directory,
      input.definition.name,
    ).pipe(Effect.catch(unavailable("read")));
    const previousPaths = Option.match(previous, {
      onNone: (): FactoryDefinition["roles"] => ({}),
      onSome: (files) => files.definition.roles,
    });
    const rolePaths: Record<string, FactoryRolePath | null> = { ...input.definition.roles };
    const writes: Array<{ readonly rolePath: FactoryRolePath; readonly text: string }> = [];
    const removals: Array<FactoryRolePath> = [];
    const changed = new Set<FactoryRoleName>();
    for (const { role, file } of input.roles ?? []) {
      if (changed.has(role)) {
        issues.push({
          code: "invalid_definition",
          role,
          field: "roles",
          message: `${role} is changed twice in this save.`,
        });
        continue;
      }
      changed.add(role);
      const isListed = listed.has(role);
      if (file === null) {
        removals.push((isListed ? rolePaths[role] : previousPaths[role]) ?? defaultRolePath(role));
        if (role === FACTORY_FOREMAN_ROLE) delete rolePaths[role];
        else if (isListed) rolePaths[role] = null;
        continue;
      }
      if (!isListed) {
        issues.push({
          code: "invalid_definition",
          role,
          field: "roles",
          message: `${role} is not one of the factory's roles. List it in roles to add it.`,
        });
        continue;
      }
      if (role === FACTORY_FOREMAN_ROLE && file.binding.enabled === false) {
        issues.push({
          code: "invalid_binding",
          role,
          field: "enabled",
          message: "The Foreman cannot be disabled.",
        });
        continue;
      }
      const rolePath = rolePaths[role] ?? defaultRolePath(role);
      rolePaths[role] = rolePath;
      writes.push({ rolePath, text: renderRoleFile(file.binding, file.body) });
      const binding = effectiveBinding(roleDefaults(role).binding, file.binding);
      issues.push(
        ...bindingIssues(role, binding, catalog.providers),
        ...resolveRoleSkills(role, binding.skills, savedSkills).issues,
      );
    }
    const used = [...Object.values(rolePaths).filter((rolePath) => rolePath !== null), ...removals];
    for (const shared of new Set(used.filter((rolePath, i) => used.indexOf(rolePath) !== i))) {
      issues.push({
        code: "invalid_definition",
        role: null,
        field: "roles",
        message: `Two roles use ${shared}; give each its own file.`,
      });
    }
    if (issues.length > 0) {
      return yield* new FactoryError({
        code: "invalid",
        message: `The factory was not saved: ${issues[0]!.message}${issues.length > 1 ? ` (${issues.length - 1} more)` : ""}`,
        issues,
      });
    }

    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      for (const { rolePath, text } of writes) {
        const target = path.join(directory, rolePath);
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        yield* fileSystem.writeFileString(target, text);
      }
      for (const rolePath of removals) {
        yield* fileSystem.remove(path.join(directory, rolePath)).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
          }),
        );
      }
      // Last, so a failed role write leaves the factory pointing at the files it had.
      yield* fileSystem.writeFileString(
        path.join(directory, FACTORY_FILE_NAME),
        renderFactoryJson({ ...input.definition, version: 2, roles: rolePaths }),
      );
    }).pipe(Effect.catch(unavailable("written")));

    return yield* read(makeFactoryId(project.projectId, input.definition.name));
  });

  const deleteFactory = Effect.fn("FactoryService.delete")(function* (factoryId: FactoryId) {
    const parsed = parseFactoryId(factoryId);
    if (parsed === null) return yield* notFound(factoryId);
    const { projects } = yield* loadCatalog;
    const project = projects.find((candidate) => candidate.projectId === parsed.projectId);
    if (project === undefined) return yield* notFound(factoryId);
    const directory = factoryDirectory(project, parsed.name);
    const definitionFile = path.join(directory, FACTORY_FILE_NAME);
    return yield* ledgerLocks.withLock(
      factoryId,
      Effect.gen(function* () {
        const exists = yield* fileSystem
          .exists(definitionFile)
          .pipe(Effect.catch(unavailable("read")));
        if (!exists) return yield* notFound(factoryId);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                DELETE FROM fork_factory_work_item_threads WHERE work_item_id IN (
                  SELECT work_item_id FROM fork_factory_work_items WHERE factory_id = ${factoryId}
                )
              `;
              yield* sql`
                DELETE FROM fork_factory_work_item_transitions WHERE work_item_id IN (
                  SELECT work_item_id FROM fork_factory_work_items WHERE factory_id = ${factoryId}
                )
              `;
              yield* sql`DELETE FROM fork_factory_work_items WHERE factory_id = ${factoryId}`;
              yield* sql`DELETE FROM fork_factory_threads WHERE factory_id = ${factoryId}`;
            }),
          )
          .pipe(Effect.catch(unavailable("written")));
        // factory.json goes last, so a failed removal leaves a factory the person can delete again.
        yield* Effect.gen(function* () {
          for (const entry of yield* fileSystem.readDirectory(directory)) {
            if (entry === FACTORY_FILE_NAME) continue;
            yield* fileSystem.remove(path.join(directory, entry), { recursive: true });
          }
          yield* fileSystem.remove(directory, { recursive: true });
        }).pipe(Effect.catch(unavailable("written")));
        return { factoryId } satisfies FactoryDeleteResult;
      }),
    );
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const launchFailed = workItemUnavailable("The Foreman thread could not be started.");

  /** Model, modes, and checkout for a new Foreman thread, from the foreman role's binding. */
  const foremanLaunch = Effect.fn("FactoryService.foremanLaunch")(function* (factory: Factory) {
    const binding =
      factory.roles.find((role) => role.role === FACTORY_FOREMAN_ROLE)?.binding ??
      rolePresets.foreman.binding;
    const project = yield* projectStore
      .get(factory.projectId)
      .pipe(Effect.catch(unavailable("read")));
    if (Option.isNone(project)) return yield* notFound(factory.id);
    const settings = yield* serverSettings.getSettings.pipe(Effect.catch(launchFailed));
    const modelSelection =
      binding.model ??
      resolveProjectSettings(settings, project.value.projectId, project.value).settings
        .defaultModelSelection ??
      project.value.defaultModelSelection;
    if (modelSelection === null) {
      return yield* new WorkItemError({
        code: "unavailable",
        message: `${project.value.title} has no default model, and the ${factory.name} factory's foreman role names none. Choose one, then try again.`,
      });
    }
    const workspaceStrategy: ThreadLaunchService.ThreadLaunchWorkspaceStrategy =
      binding.isolation === "shared"
        ? { type: "root" }
        : {
            type: "worktree",
            baseRef: (yield* gitDriver
              .resolveCommit({ cwd: project.value.workspaceRoot, revision: "HEAD" })
              .pipe(Effect.catch(launchFailed))).commitSha,
            startFromOrigin: false,
          };
    return { binding, modelSelection, workspaceStrategy };
  });

  const ledgerUnavailable = workItemUnavailable("Work items could not be read or written.");

  const loadWorkItems = Effect.fn("FactoryService.loadWorkItems")(function* (
    filter: WorkItemFilter & { readonly workItemIds?: ReadonlyArray<WorkItemId> },
  ) {
    const outcome = filter.outcome;
    const rows = yield* sql`
      SELECT
        w.work_item_id AS "id",
        w.factory_id AS "factoryId",
        w.title,
        w.source_json AS "source",
        w.stage,
        w.gate_json AS "gate",
        w.foreman_thread_id AS "foremanThreadId",
        w.foreman_run_id AS "foremanRunId",
        w.dispatched_at AS "dispatchedAt",
        w.failure_dismissed_at AS "failureDismissedAt",
        w.stage = 'failed' AND COALESCE((
          SELECT json_extract(t.actor_json, '$.kind')
          FROM fork_factory_work_item_transitions t
          WHERE t.work_item_id = w.work_item_id
            AND t.to_stage = 'failed' AND t.from_stage <> 'failed'
          ORDER BY t.at DESC, t.rowid DESC
          LIMIT 1
        ), '') = 'user' AS "failedByUser",
        w.created_at AS "createdAt",
        w.updated_at AS "updatedAt"
      FROM fork_factory_work_items w
      WHERE ${sql.and([
        ...(filter.workItemIds === undefined ? [] : [sql.in("w.work_item_id", filter.workItemIds)]),
        ...(filter.factoryId === undefined ? [] : [sql`w.factory_id = ${filter.factoryId}`]),
        ...(filter.stage === undefined ? [] : [sql`w.stage = ${filter.stage}`]),
        ...(outcome === undefined
          ? []
          : outcome === "active"
            ? [sql`w.stage NOT IN ('done', 'failed', 'dropped')`]
            : [sql`w.stage = ${outcome}`]),
        ...(filter.role === undefined
          ? []
          : [
              sql`EXISTS (
                SELECT 1 FROM fork_factory_work_item_threads t
                JOIN orchestration_v2_projection_threads p ON p.thread_id = t.thread_id
                WHERE t.work_item_id = w.work_item_id AND t.role = ${filter.role}
              )`,
            ]),
      ])}
      ORDER BY w.created_at DESC, w.rowid DESC
      LIMIT ${WORK_ITEM_LIST_LIMIT}
    `.pipe(NodeSqliteClient.readOnly, Effect.flatMap(decodeWorkItemRows));
    const ids = rows.map((row) => row.id);
    // A child's row lands before its thread does; a delegation that failed leaves one with none.
    const threadRows =
      ids.length === 0
        ? []
        : yield* sql<{
            readonly workItemId: string;
            readonly threadId: string;
            readonly role: string | null;
          }>`
            SELECT t.work_item_id AS "workItemId", t.thread_id AS "threadId", t.role
            FROM fork_factory_work_item_threads t
            JOIN orchestration_v2_projection_threads p ON p.thread_id = t.thread_id
            WHERE t.work_item_id IN ${sql.in(ids)}
            ORDER BY t.created_at, t.rowid
          `.pipe(NodeSqliteClient.readOnly);
    return rows.map((row): WorkItemSummary => ({
      ...row,
      failedByUser: row.failedByUser === 1,
      threads: threadRows
        .filter((thread) => thread.workItemId === row.id)
        .map((thread): WorkItemThread => ({
          threadId: ThreadId.make(thread.threadId),
          role: isRoleName(thread.role) ? thread.role : null,
        })),
    }));
  });

  const listWorkItems = Effect.fn("FactoryService.listWorkItems")(function* (
    filter: WorkItemFilter,
  ) {
    const workItems = yield* loadWorkItems(filter).pipe(Effect.catch(ledgerUnavailable));
    return { workItems } satisfies WorkItemListResult;
  });

  const readWorkItem = Effect.fn("FactoryService.readWorkItem")(function* (workItemId: WorkItemId) {
    const [summary] = yield* loadWorkItems({ workItemIds: [workItemId] }).pipe(
      Effect.catch(ledgerUnavailable),
    );
    if (summary === undefined) return yield* workItemNotFound(workItemId);
    const transitions = yield* sql`
      SELECT
        transition_id AS "id",
        work_item_id AS "workItemId",
        from_stage AS "from",
        to_stage AS "to",
        actor_json AS "actor",
        note,
        at
      FROM fork_factory_work_item_transitions
      WHERE work_item_id = ${workItemId}
      ORDER BY at, rowid
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.flatMap(decodeTransitionRows),
      Effect.catch(ledgerUnavailable),
    );
    return {
      ...summary,
      transitions: transitions.map(({ workItemId: _workItemId, ...transition }) => transition),
    } satisfies WorkItem;
  });

  /**
   * One stage change: the item's row, its transition, and any threads it names, together. At the
   * same stage, a note is a log entry: a transition from the stage to itself.
   */
  const moveWorkItem = Effect.fn("FactoryService.moveWorkItem")(function* (input: {
    readonly item: WorkItemSummary;
    readonly to: WorkItemStage;
    readonly actor: WorkItemActor;
    readonly note: string | null;
    readonly gate?: WorkItemGate;
    readonly threads?: ReadonlyArray<WorkItemThread>;
  }) {
    const at = yield* nowIso;
    const transitionId = `work-item-transition:${yield* randomUuidV4}`;
    const gateJson = yield* encodeGate(input.gate ?? input.item.gate).pipe(
      Effect.catch(ledgerUnavailable),
    );
    const actorJson = yield* encodeActor(input.actor).pipe(Effect.catch(ledgerUnavailable));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE fork_factory_work_items
            SET stage = ${input.to},
              gate_json = ${gateJson},
              updated_at = ${at}
            WHERE work_item_id = ${input.item.id}
          `;
          if (input.to !== input.item.stage || input.note !== null) {
            yield* sql`
              INSERT INTO fork_factory_work_item_transitions (
                transition_id, work_item_id, from_stage, to_stage, actor_json, note, at
              ) VALUES (
                ${transitionId}, ${input.item.id}, ${input.item.stage}, ${input.to},
                ${actorJson}, ${input.note}, ${at}
              )
            `;
          }
          yield* Effect.forEach(
            input.threads ?? [],
            (thread) => sql`
              INSERT INTO fork_factory_work_item_threads (work_item_id, thread_id, role, created_at)
              VALUES (${input.item.id}, ${thread.threadId}, ${thread.role}, ${at})
              ON CONFLICT (work_item_id, thread_id) DO UPDATE SET role = excluded.role
            `,
            { discard: true },
          );
        }),
      )
      .pipe(Effect.catch(ledgerUnavailable));
    return transitionId;
  });

  const loadWorkItem = (workItemId: WorkItemId) =>
    loadWorkItems({ workItemIds: [workItemId] }).pipe(
      Effect.catch(ledgerUnavailable),
      Effect.flatMap(([item]) =>
        item === undefined ? Effect.fail(workItemNotFound(workItemId)) : Effect.succeed(item),
      ),
    );

  /** Runs `use` on the item as it is under its factory's ledger lock. */
  const withLedgerItem = <A, E, R>(
    workItemId: WorkItemId,
    use: (item: WorkItemSummary) => Effect.Effect<A, E, R>,
  ) =>
    loadWorkItem(workItemId).pipe(
      Effect.flatMap(({ factoryId }) =>
        ledgerLocks.withLock(factoryId, Effect.flatMap(loadWorkItem(workItemId), use)),
      ),
    );

  /** Like `withLedgerItem`, once `callerThreadId` proves to be the item's Foreman. */
  const withForemanItem = <A, E, R>(
    callerThreadId: ThreadId,
    workItemId: WorkItemId,
    use: (item: WorkItemSummary) => Effect.Effect<A, E, R>,
  ) =>
    withLedgerItem(workItemId, (item) =>
      Effect.gen(function* () {
        const listed = yield* sql<{ readonly found: number }>`
          SELECT 1 AS found FROM fork_factory_threads
          WHERE thread_id = ${callerThreadId} AND factory_id = ${item.factoryId}
            AND role = 'foreman'
        `.pipe(Effect.catch(ledgerUnavailable));
        if (item.foremanThreadId !== callerThreadId || listed.length === 0) {
          return yield* new WorkItemError({
            code: "not_foreman",
            message: `Only work item ${workItemId}'s Foreman thread may change it.`,
          });
        }
        return yield* use(item);
      }),
    );

  const foremanUnreachable = workItemUnavailable(
    "The Foreman thread could not be sent the work item.",
  );

  const sendToForeman = (input: ThreadManagementService.ThreadManagementSendInput) =>
    threadManagement.sendToThread(input).pipe(Effect.catch(foremanUnreachable));

  /**
   * Launches the item's own Foreman thread with the item as its first message, so a worktree run
   * waits in `preparing` until its worktree is bound. Ids derive from the item, so a repeat after a
   * crash replays the same launch.
   */
  const launchRun = Effect.fn("FactoryService.launchRun")(function* (item: WorkItemSummary) {
    const factory = yield* read(item.factoryId);
    const launch = yield* foremanLaunch(factory);
    const threadId = ThreadId.make(`${FACTORY_FOREMAN_THREAD_ID_PREFIX}${item.id}`);
    const messageId = MessageId.make(`factory-work-item:${item.id}`);
    // The row lands before the launch, so the first provider session sees the role.
    yield* sql`
      INSERT INTO fork_factory_threads (factory_id, thread_id, role, created_at)
      VALUES (${factory.id}, ${threadId}, 'foreman', ${yield* nowIso})
      ON CONFLICT (thread_id) DO NOTHING
    `.pipe(Effect.catch(unavailable("written")));
    const launched = yield* threadLaunch
      .launch({
        commandId: CommandId.make(`factory-foreman-launch:${item.id}`),
        threadId,
        projectId: factory.projectId,
        title: item.title,
        modelSelection: launch.modelSelection,
        runtimeMode: launch.binding.runtimeMode,
        interactionMode: launch.binding.interactionMode,
        workspaceStrategy: launch.workspaceStrategy,
        initialMessage: {
          messageId,
          text: renderWorkItemMessage({
            workItemId: item.id,
            factoryName: factory.name,
            title: item.title,
            source: item.source,
          }),
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.catch((error) =>
          sql`DELETE FROM fork_factory_threads WHERE thread_id = ${threadId}`.pipe(
            Effect.ignore({ log: true }),
            Effect.andThen(launchFailed(error)),
          ),
        ),
      );
    const runId =
      launched.projection.messages.find((message) => message.id === messageId)?.runId ?? null;
    const at = yield* nowIso;
    yield* sql`
      UPDATE fork_factory_work_items
      SET foreman_thread_id = ${threadId}, foreman_run_id = ${runId}, dispatched_at = ${at},
        updated_at = ${at}
      WHERE work_item_id = ${item.id}
    `.pipe(Effect.catch(ledgerUnavailable));
  });

  /**
   * Starts an item at `new` that has no run yet; any other item is left alone. One the server
   * cannot start fails, and the error comes back. Each is also on the item's own record.
   */
  const dispatchWorkItem = (workItemId: WorkItemId) =>
    withLedgerItem(workItemId, (item) =>
      Effect.gen(function* () {
        if (item.stage !== "new" || item.dispatchedAt !== null) return null;
        const error = yield* launchRun(item).pipe(
          Effect.as(null),
          Effect.catch((cause) => Effect.succeed(cause)),
        );
        if (error === null) return null;
        // The item stays on record as failed, so the person sees what did not start.
        yield* moveWorkItem({ item, to: "failed", actor: { kind: "server" }, note: error.message });
        return error;
      }),
    );

  const dispatchPending: FactoryService["Service"]["dispatchPending"] = Effect.gen(function* () {
    const pending = yield* sql<{ readonly id: string }>`
      SELECT work_item_id AS "id" FROM fork_factory_work_items
      WHERE stage = 'new' AND dispatched_at IS NULL
      ORDER BY created_at, rowid
    `;
    for (const { id } of pending) {
      const error = yield* dispatchWorkItem(WorkItemId.make(id));
      if (error !== null) {
        yield* Effect.logWarning("Could not start a pending work item's Foreman thread", {
          workItemId: id,
          error: error.message,
        });
      }
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not start pending work items", { errorTag: error._tag }),
    ),
    Effect.withSpan("FactoryService.dispatchPending"),
  );

  const advanceWorkItem = Effect.fn("FactoryService.advanceWorkItem")(function* (
    callerThreadId: ThreadId,
    input: WorkItemAdvanceInput,
  ) {
    yield* withForemanItem(callerThreadId, input.workItemId, (item) =>
      Effect.gen(function* () {
        if (item.stage === "waiting") {
          return yield* new WorkItemError({
            code: "gate_waiting",
            message: `Work item ${item.id} waits on a person's answer to its gate, which moves it on.`,
          });
        }
        if (!canTransitionWorkItem(item.stage, input.stage, item.gate)) {
          return yield* new WorkItemTransitionError({
            workItemId: item.id,
            from: item.stage,
            to: input.stage,
          });
        }
        yield* moveWorkItem({
          item,
          to: input.stage,
          actor: { kind: "foreman", threadId: callerThreadId },
          note: input.note ?? null,
        });
      }),
    );
    return yield* readWorkItem(input.workItemId);
  });

  const gateWorkItem = Effect.fn("FactoryService.gateWorkItem")(function* (
    callerThreadId: ThreadId,
    input: WorkItemGateInput,
  ) {
    yield* withForemanItem(callerThreadId, input.workItemId, (item) =>
      Effect.gen(function* () {
        if (!canTransitionWorkItem(item.stage, "waiting", item.gate)) {
          return yield* new WorkItemTransitionError({
            workItemId: item.id,
            from: item.stage,
            to: "waiting",
          });
        }
        yield* moveWorkItem({
          item,
          to: "waiting",
          actor: { kind: "foreman", threadId: callerThreadId },
          note: input.question,
          gate: {
            state: "waiting",
            question: input.question,
            resumeStage: input.resumeStage,
            askedAt: yield* nowIso,
          },
        });
      }),
    );
    return yield* readWorkItem(input.workItemId);
  });

  const createWorkItem = (input: WorkItemCreateInput) =>
    insertWorkItem({
      factoryId: input.factoryId,
      title: input.title,
      source: { kind: "manual", text: input.text },
    });

  const createWorkItemFromTrigger: FactoryService["Service"]["createWorkItemFromTrigger"] = (
    input,
  ) => insertWorkItem(input);

  const insertWorkItem = Effect.fn("FactoryService.createWorkItem")(function* (input: {
    readonly factoryId: FactoryId;
    readonly title: string;
    readonly source: WorkItemSource;
  }) {
    const factory = yield* read(input.factoryId);
    const workItemId = WorkItemId.make(`work-item:${yield* randomUuidV4}`);
    const { source } = input;
    const createdAt = yield* nowIso;
    const sourceJson = yield* encodeSource(source).pipe(Effect.catch(ledgerUnavailable));
    const gateJson = yield* encodeGate({ state: "none" }).pipe(Effect.catch(ledgerUnavailable));
    yield* sql`
      INSERT INTO fork_factory_work_items (
        work_item_id, factory_id, title, source_json, stage, gate_json,
        foreman_thread_id, foreman_run_id, dispatched_at, created_at, updated_at
      ) VALUES (
        ${workItemId}, ${factory.id}, ${input.title}, ${sourceJson}, 'new', ${gateJson},
        NULL, NULL, NULL, ${createdAt}, ${createdAt}
      )
    `.pipe(Effect.catch(ledgerUnavailable));
    const failure = yield* dispatchWorkItem(workItemId);
    if (failure !== null) return yield* failure;
    return yield* readWorkItem(workItemId);
  });

  const answerWorkItemGate = Effect.fn("FactoryService.answerWorkItemGate")(function* (
    userId: AuthUserId | null,
    input: WorkItemAnswerGateInput,
  ) {
    yield* withLedgerItem(input.workItemId, (item) =>
      Effect.gen(function* () {
        const gate = item.gate;
        if (item.stage !== "waiting" || gate.state !== "waiting") {
          return yield* new WorkItemError({
            code: "no_gate",
            message: `Work item ${item.id} has no gate waiting for an answer.`,
          });
        }
        const to: WorkItemStage = input.decision === "approved" ? gate.resumeStage : "dropped";
        if (!canTransitionWorkItem(item.stage, to, gate)) {
          return yield* new WorkItemTransitionError({ workItemId: item.id, from: item.stage, to });
        }
        const transitionId = yield* moveWorkItem({
          item,
          to,
          actor: { kind: "user", userId },
          note: input.note === "" ? null : input.note,
          gate: {
            state: "answered",
            question: gate.question,
            decision: input.decision,
            note: input.note,
            answeredAt: yield* nowIso,
            resumeStage: gate.resumeStage,
          },
        });
        const projectId = parseFactoryId(item.factoryId)?.projectId;
        // Continues the item's own Foreman thread, steering it when it is running.
        const unsent =
          item.foremanThreadId === null || projectId === undefined
            ? null
            : yield* sendToForeman({
                projectId,
                commandId: CommandId.make(`factory-gate-answer:${transitionId}`),
                threadId: item.foremanThreadId,
                messageId: MessageId.make(`factory-gate-answer:${transitionId}`),
                text: renderGateAnswerMessage({
                  workItemId: item.id,
                  question: gate.question,
                  decision: input.decision,
                  note: input.note,
                  stage: to,
                }),
                attachments: [],
                mode: "auto",
                createdBy: "agent",
                creationSource: "server",
              }).pipe(
                Effect.as(null),
                Effect.catch((cause) => Effect.succeed(cause)),
              );
        if (unsent !== null) return yield* unsent;
      }),
    );
    return yield* readWorkItem(input.workItemId);
  });

  const setWorkItemFailureDismissed = Effect.fn("FactoryService.setWorkItemFailureDismissed")(
    function* (userId: AuthUserId | null, input: WorkItemDismissFailureInput) {
      const actorJson = yield* encodeActor({ kind: "user", userId }).pipe(
        Effect.catch(ledgerUnavailable),
      );
      yield* withLedgerItem(input.workItemId, (item) =>
        Effect.gen(function* () {
          if (item.stage !== "failed") {
            return yield* new WorkItemError({
              code: "not_failed",
              message: `Work item ${item.id} has not failed, so it has no failure to dismiss.`,
            });
          }
          if ((item.failureDismissedAt !== null) === input.dismissed) return;
          const at = yield* nowIso;
          const transitionId = `work-item-transition:${yield* randomUuidV4}`;
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  UPDATE fork_factory_work_items
                  SET failure_dismissed_at = ${input.dismissed ? at : null}, updated_at = ${at}
                  WHERE work_item_id = ${item.id}
                `;
                yield* sql`
                  INSERT INTO fork_factory_work_item_transitions (
                    transition_id, work_item_id, from_stage, to_stage, actor_json, note, at
                  ) VALUES (
                    ${transitionId}, ${item.id}, 'failed', 'failed', ${actorJson},
                    ${input.dismissed ? "Dismissed the failure." : "Restored the failure."}, ${at}
                  )
                `;
              }),
            )
            .pipe(Effect.catch(ledgerUnavailable));
        }),
      );
      return yield* readWorkItem(input.workItemId);
    },
  );

  const dropWorkItem = Effect.fn("FactoryService.dropWorkItem")(function* (
    userId: AuthUserId | null,
    input: WorkItemDropInput,
  ) {
    yield* withLedgerItem(input.workItemId, (item) =>
      Effect.gen(function* () {
        if (!canTransitionWorkItem(item.stage, "dropped", item.gate)) {
          return yield* new WorkItemTransitionError({
            workItemId: item.id,
            from: item.stage,
            to: "dropped",
          });
        }
        const transitionId = yield* moveWorkItem({
          item,
          to: "dropped",
          actor: { kind: "user", userId },
          note: null,
        });
        const projectId = parseFactoryId(item.factoryId)?.projectId;
        // Steers the item's Foreman thread when it is running, as a rejected gate does.
        const unsent =
          item.foremanThreadId === null || projectId === undefined
            ? null
            : yield* sendToForeman({
                projectId,
                commandId: CommandId.make(`factory-drop:${transitionId}`),
                threadId: item.foremanThreadId,
                messageId: MessageId.make(`factory-drop:${transitionId}`),
                text: renderDropMessage(item.id),
                attachments: [],
                mode: "auto",
                createdBy: "agent",
                creationSource: "server",
              }).pipe(
                Effect.as(null),
                Effect.catch((cause) => Effect.succeed(cause)),
              );
        if (unsent !== null) return yield* unsent;
      }),
    );
    return yield* readWorkItem(input.workItemId);
  });

  /** The item `parentThreadId` is the Foreman thread of, while it is not done, failed, or dropped. */
  const foremanRunItem = Effect.fn("FactoryService.foremanRunItem")(function* (
    parentThreadId: ThreadId,
  ) {
    const [item] = yield* sql<{ readonly workItemId: string; readonly stage: string }>`
      SELECT work_item_id AS "workItemId", stage FROM fork_factory_work_items
      WHERE foreman_thread_id = ${parentThreadId}
    `;
    if (item === undefined || !isWorkItemStage(item.stage) || isTerminalWorkItemStage(item.stage))
      return null;
    return { id: WorkItemId.make(item.workItemId), stage: item.stage };
  });

  /**
   * Why no child can commit in the checkout, or null when Git resolves a committer identity.
   * `git var` fails the way `git commit` would, so this never accepts a guessed identity.
   */
  const missingGitIdentity = Effect.fn("FactoryService.missingGitIdentity")(function* (
    cwd: string,
  ) {
    const git = (args: ReadonlyArray<string>) =>
      gitDriver.execute({
        operation: "FactoryService.missingGitIdentity",
        cwd,
        args,
        allowNonZeroExit: true,
      });
    const ident = yield* git(["var", "GIT_COMMITTER_IDENT"]);
    if (ident.exitCode === 0) return null;
    const unset: Array<string> = [];
    for (const key of ["user.name", "user.email"]) {
      if ((yield* git(["config", "--get", key])).exitCode !== 0) unset.push(key);
    }
    const said = ident.stderr.trim().split("\n").at(-1)?.trim() ?? "";
    return `Git has no committer identity in ${cwd}, so no child can commit there.${
      unset.length === 0
        ? ""
        : ` ${unset.join(" and ")} ${unset.length === 1 ? "is" : "are"} not set.`
    }${said === "" ? "" : ` Git says: ${said}`} Set the identity, for example with git config --global, then approve this gate.`;
  });

  /**
   * Before an item's first child, holds the item at a gate when its checkout cannot commit.
   * Fails with `gate_waiting` while the item waits, so the Foreman ends its turn.
   */
  const requireCommitIdentity = Effect.fn("FactoryService.requireCommitIdentity")(function* (
    factory: Factory,
    workItemId: WorkItemId,
  ) {
    yield* withLedgerItem(workItemId, (item) =>
      Effect.gen(function* () {
        if (item.threads.length > 0) return;
        const project = yield* projectStore
          .get(factory.projectId)
          .pipe(Effect.catch(ledgerUnavailable));
        if (Option.isNone(project)) return yield* workItemNotFound(workItemId);
        const missing = yield* missingGitIdentity(project.value.workspaceRoot).pipe(
          Effect.catch(workItemUnavailable("Git could not be asked for a committer identity.")),
        );
        if (missing === null) return;
        if (canTransitionWorkItem(item.stage, "waiting", item.gate)) {
          yield* moveWorkItem({
            item,
            to: "waiting",
            actor: { kind: "server" },
            note: missing,
            gate: {
              state: "waiting",
              question: missing,
              resumeStage: "working",
              askedAt: yield* nowIso,
            },
          });
        }
        return yield* new WorkItemError({
          code: "gate_waiting",
          message: `Work item ${item.id} waits at a gate for a person: ${missing} End your turn; their answer arrives as your next message.`,
        });
      }),
    );
  });

  const prepareDelegation = Effect.fn("FactoryService.prepareDelegation")(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly commandId: CommandId;
    readonly delegation: FactoryDelegation;
    readonly factoryRole: FactoryDelegationRole | null;
  }) {
    const named = input.factoryRole;
    const [owner] = yield* sql<{ readonly factoryId: string }>`
      SELECT factory_id AS "factoryId" FROM fork_factory_threads
      WHERE thread_id = ${input.parentThreadId} AND role = 'foreman'
    `.pipe(NodeSqliteClient.readOnly, Effect.catch(ledgerUnavailable));
    const item =
      owner === undefined
        ? null
        : yield* foremanRunItem(input.parentThreadId).pipe(Effect.catch(ledgerUnavailable));
    if (item === null || owner === undefined) {
      if (named === null) return input.delegation;
      return yield* new WorkItemError({
        code: "not_foreman",
        message: `Only work item ${named.workItemId}'s Foreman thread may delegate for it, until the item ends.`,
      });
    }
    if (named !== null && named.workItemId !== item.id) {
      return yield* new WorkItemError({
        code: "not_foreman",
        message: `This thread is the Foreman of work item ${item.id}, not ${named.workItemId}.`,
      });
    }
    const factory = yield* read(FactoryId.make(owner.factoryId));
    if (item.stage === "waiting") {
      return yield* new WorkItemError({
        code: "gate_waiting",
        message: `Work item ${item.id} waits on a person's answer to its gate, so nothing can be delegated for it. End your turn; their answer arrives as your next message.`,
      });
    }
    if (named === null) {
      const usable = delegateRoles(factory);
      return yield* new WorkItemError({
        code: "no_role",
        message: `Each child of work item ${item.id} runs as one of the factory's roles. Delegate with t3_factory_delegate and name the role. Roles you can delegate to: ${usable.length === 0 ? "none" : usable.join(", ")}.`,
      });
    }
    const problem = roleProblem(factory, named.role, "delegate to");
    if (problem !== null) return yield* problem;
    const role = factory.roles.find((candidate) => candidate.role === named.role)!;
    yield* requireCommitIdentity(factory, item.id);
    const bound = bindDelegation(role.role, input.delegation, role.binding);
    // The orchestrator derives the child's id from the command the same way.
    const childThreadId = IdAllocator.derive.delegatedTaskThread({ commandId: input.commandId });
    yield* withLedgerItem(item.id, (current) =>
      Effect.gen(function* () {
        if (current.stage !== "new" && current.stage !== "working") {
          return yield* new WorkItemError({
            code: current.stage === "waiting" ? "gate_waiting" : "not_foreman",
            message: `Work item ${item.id} is ${current.stage}, so nothing can be delegated for it.`,
          });
        }
        yield* moveWorkItem({
          item: current,
          to: "working",
          actor: { kind: "server" },
          note: bound.note,
          threads: [{ threadId: childThreadId, role: role.role }],
        });
      }),
    );
    return bound.delegation;
  });

  // Items a restart left undispatched; off the startup path, and logged on failure.
  yield* ServerActivation.forkParked(dispatchPending);

  return FactoryService.of({
    list,
    read,
    save,
    delete: deleteFactory,
    listWorkItems,
    readWorkItem,
    createWorkItem,
    createWorkItemFromTrigger,
    advanceWorkItem,
    gateWorkItem,
    answerWorkItemGate,
    setWorkItemFailureDismissed,
    dropWorkItem,
    dispatchPending,
    prepareDelegation,
  });
});

export const layer = Layer.effect(FactoryService, make);
