/**
 * Fork-only software factories (docs/internals/factories.md). Reads and writes each factory's
 * definition files in its project's checkout, reports what the factory owns and what of that
 * needs a person, keeps the work item ledger, and launches and messages the Foreman thread.
 */
import {
  type AuthUserId,
  canTransitionWorkItem,
  CommandId,
  FACTORY_FOREMAN_THREAD_ID_PREFIX,
  type Factory,
  type FactoryAttention,
  type FactoryDefinition,
  FactoryError,
  FactoryId,
  type FactoryIssue,
  type FactoryListResult,
  FactoryName,
  type FactoryProject,
  type FactoryRole,
  FactoryRoleName,
  type FactoryRolePath,
  type FactorySaveInput,
  type FactoryThread,
  isTerminalWorkItemStage,
  makeFactoryId,
  MessageId,
  type OrchestratorMcpTaskRole,
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
  WorkItemError,
  WorkItemGate,
  type WorkItemGateInput,
  WorkItemId,
  type WorkItemListResult,
  type WorkItemOutcome,
  WorkItemSource,
  WorkItemStage,
  type WorkItemSummary,
  type WorkItemThread,
  WorkItemTransitionError,
} from "@t3tools/contracts";
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
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  bindingIssues,
  defaultRolePath,
  effectiveBinding,
  FACTORIES_DIRECTORY,
  FACTORY_FILE_NAME,
  parseFactoryJson,
  parseRoleFile,
  renderFactoryJson,
  renderRoleFile,
  resolveProjects,
} from "./factoryFiles.ts";
import { builtinRoles } from "./roles/index.ts";
import type { freshContext } from "./upstream/index.ts";
import {
  renderGateAnswerMessage,
  renderWorkItemMessage,
  workItemRoleForTask,
} from "./workItems.ts";

const ROLE_NAMES = FactoryRoleName.literals;
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
    /** The factory's Foreman thread; null when it has none, or its thread is archived or gone. */
    readonly foremanThread: (factoryId: FactoryId) => Effect.Effect<ThreadId | null, FactoryError>;
    /** Launches a Foreman thread when the factory has no live one, and returns its thread. */
    readonly ensureForemanThread: (
      factoryId: FactoryId,
    ) => Effect.Effect<ThreadId, FactoryError | WorkItemError>;
    /** Newest first, at most 200. Without a factory, every factory's. */
    readonly listWorkItems: (
      filter: WorkItemFilter,
    ) => Effect.Effect<WorkItemListResult, WorkItemError>;
    readonly readWorkItem: (workItemId: WorkItemId) => Effect.Effect<WorkItem, WorkItemError>;
    /** Records the item at `new`, then sends it to the Foreman as a fresh session's message. */
    readonly createWorkItem: (
      input: WorkItemCreateInput,
    ) => Effect.Effect<WorkItem, FactoryError | WorkItemError>;
    /** The item's Foreman moves it on and names the threads that worked on it. */
    readonly advanceWorkItem: (
      callerThreadId: ThreadId,
      input: WorkItemAdvanceInput,
    ) => Effect.Effect<WorkItem, WorkItemError | WorkItemTransitionError>;
    /** The item's Foreman holds it for a person. */
    readonly gateWorkItem: (
      callerThreadId: ThreadId,
      input: WorkItemGateInput,
    ) => Effect.Effect<WorkItem, WorkItemError | WorkItemTransitionError>;
    /** Records a person's answer, then tells the Foreman in the item's session. */
    readonly answerWorkItemGate: (
      userId: AuthUserId | null,
      input: WorkItemAnswerGateInput,
    ) => Effect.Effect<WorkItem, WorkItemError | WorkItemTransitionError>;
    /**
     * Names a delegated task's child on the work item its Foreman parent runs, when the parent
     * is a Foreman thread. Logs and ignores failures, since delegation must not depend on it.
     */
    readonly attachDelegatedChild: (input: {
      readonly parentThreadId: ThreadId;
      readonly parentRunId: RunId;
      readonly childThreadId: ThreadId;
      readonly taskRole: OrchestratorMcpTaskRole | undefined;
    }) => Effect.Effect<void>;
  }
>()("t3/factories/FactoryService") {}

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

const builtinRole = (role: FactoryRoleName, path: FactoryRolePath | null): FactoryRole => ({
  role,
  path,
  source: "builtin",
  fileBinding: {},
  binding: builtinRoles[role].binding,
  body: builtinRoles[role].body,
  bodySource: "builtin",
});

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
  // One launch per factory at a time, and one stage change per item at a time.
  const foremanLocks = yield* KeyedLock.make<FactoryId>();
  const workItemLocks = yield* KeyedLock.make<WorkItemId>();

  const factoryDirectory = (project: ProjectRow, name: FactoryName) =>
    path.join(project.workspaceRoot, ...FACTORIES_DIRECTORY, name);

  /** None when the file does not exist. */
  const readText = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(error),
      }),
    );

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

  const loadRole = Effect.fn("FactoryService.loadRole")(function* (
    directory: string,
    role: FactoryRoleName,
    rolePath: FactoryRolePath | undefined,
    providers: ReadonlyArray<ServerProvider>,
  ) {
    // A role left out of factory.json still has a file when roles/<role>.md exists.
    const listed = rolePath !== undefined;
    const filePath = rolePath ?? defaultRolePath(role);
    const text = yield* readText(path.join(directory, filePath));
    if (Option.isNone(text)) {
      if (!listed) return { role: builtinRole(role, null), issues: [] };
      return {
        role: builtinRole(role, filePath),
        issues: [
          {
            code: "missing_role_file",
            role,
            field: null,
            message: `${filePath} does not exist, so ${role} uses its built-in default.`,
          } satisfies FactoryIssue,
        ],
      };
    }
    const parsed = parseRoleFile(role, text.value);
    const binding = effectiveBinding(builtinRoles[role].binding, parsed.binding);
    return {
      role: {
        role,
        path: filePath,
        source: "file",
        fileBinding: parsed.binding,
        binding,
        body: parsed.body ?? builtinRoles[role].body,
        bodySource: parsed.body === null ? "builtin" : "file",
      } satisfies FactoryRole,
      issues: [...parsed.issues, ...bindingIssues(role, binding, providers)],
    };
  });

  const loadFactory = Effect.fn("FactoryService.loadFactory")(function* (
    project: ProjectRow,
    name: FactoryName,
    providers: ReadonlyArray<ServerProvider>,
  ) {
    const directory = factoryDirectory(project, name);
    const text = yield* readText(path.join(directory, FACTORY_FILE_NAME));
    if (Option.isNone(text)) return Option.none<LoadedFactory>();
    const { definition, issues } = parseFactoryJson(name, text.value);
    const roles = yield* Effect.forEach(ROLE_NAMES, (role) =>
      loadRole(directory, role, definition.roles[role], providers),
    );
    return Option.some<LoadedFactory>({
      id: makeFactoryId(project.projectId, name),
      project,
      name,
      definition,
      roles: roles.map((loaded) => loaded.role),
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
    // A failed item counts unless a person failed it, as a rejected gate would.
    const workItemCounts =
      factoryIds.length === 0
        ? []
        : yield* sql<{
            readonly factoryId: string;
            readonly waiting: number;
            readonly failed: number;
          }>`
            SELECT
              w.factory_id AS "factoryId",
              SUM(CASE WHEN w.stage = 'waiting' THEN 1 ELSE 0 END) AS waiting,
              SUM(CASE WHEN w.stage = 'failed' AND COALESCE((
                SELECT json_extract(t.actor_json, '$.kind')
                FROM fork_factory_work_item_transitions t
                WHERE t.work_item_id = w.work_item_id
                ORDER BY t.at DESC, t.rowid DESC
                LIMIT 1
              ), '') <> 'user' THEN 1 ELSE 0 END) AS failed
            FROM fork_factory_work_items w
            WHERE w.factory_id IN ${sql.in(factoryIds)}
            GROUP BY w.factory_id
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

    const threadIds = [...new Set(owned.flatMap(({ threads }) => threads.map((t) => t.threadId)))];
    const shells =
      threadIds.length === 0
        ? []
        : (yield* threadManagement.getShellSnapshot({ location: "active", threadIds })).threads;
    const shellById = new Map(shells.map((shell) => [shell.id, shell]));

    return owned.map(({ factory, scheduledTaskIds, threads }): OwnedView => {
      const counts = workItemCounts.find((row) => row.factoryId === factory.id);
      const gatesWaiting = counts?.waiting ?? 0;
      let failedRuns = counts?.failed ?? 0;
      let questions = 0;
      for (const { threadId } of threads) {
        const shell = shellById.get(threadId);
        if (shell === undefined) continue;
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

    const rolePaths: { [Role in FactoryRoleName]?: FactoryRolePath } = {
      ...input.definition.roles,
    };
    const writes: Array<{ readonly rolePath: FactoryRolePath; readonly text: string }> = [];
    const removals: Array<FactoryRolePath> = [];
    const issues: Array<FactoryIssue> = [];
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
      const rolePath = rolePaths[role] ?? defaultRolePath(role);
      if (file === null) {
        removals.push(rolePath);
        delete rolePaths[role];
        continue;
      }
      rolePaths[role] = rolePath;
      writes.push({ rolePath, text: renderRoleFile(file.binding, file.body) });
      issues.push(
        ...bindingIssues(
          role,
          effectiveBinding(builtinRoles[role].binding, file.binding),
          catalog.providers,
        ),
      );
    }
    const touched = [...writes.map((write) => write.rolePath), ...removals];
    for (const shared of new Set(
      touched.filter((rolePath, i) => touched.indexOf(rolePath) !== i),
    )) {
      issues.push({
        code: "invalid_definition",
        role: null,
        field: "roles",
        message: `Two roles in this save use ${shared}; give each its own file.`,
      });
    }
    if (issues.length > 0) {
      return yield* new FactoryError({
        code: "invalid",
        message: `The factory was not saved: ${issues[0]!.message}${issues.length > 1 ? ` (${issues.length - 1} more)` : ""}`,
        issues,
      });
    }

    const directory = factoryDirectory(project, input.definition.name);
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
        renderFactoryJson({ ...input.definition, roles: rolePaths }),
      );
    }).pipe(Effect.catch(unavailable("written")));

    return yield* read(makeFactoryId(project.projectId, input.definition.name));
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /** The newest foreman row's thread, and whether that thread is still usable. */
  const foremanRow = Effect.fn("FactoryService.foremanRow")(function* (factoryId: FactoryId) {
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM fork_factory_threads
      WHERE factory_id = ${factoryId} AND role = 'foreman'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `.pipe(Effect.catch(unavailable("read")));
    const row = rows[0];
    if (row === undefined) return null;
    const threadId = ThreadId.make(row.threadId);
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.catch(unavailable("read")));
    return {
      threadId,
      live: shell !== null && shell.deletedAt === null && shell.archivedAt === null,
    };
  });

  const foremanThread = Effect.fn("FactoryService.foremanThread")(function* (factoryId: FactoryId) {
    const row = yield* foremanRow(factoryId);
    return row?.live === true ? row.threadId : null;
  });

  const launchFailed = workItemUnavailable("The Foreman thread could not be started.");

  /** Model, modes, and checkout for a new Foreman thread, from the foreman role's binding. */
  const foremanLaunch = Effect.fn("FactoryService.foremanLaunch")(function* (factory: Factory) {
    const binding =
      factory.roles.find((role) => role.role === "foreman")?.binding ??
      builtinRoles.foreman.binding;
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

  const ensureForeman = Effect.fn("FactoryService.ensureForeman")(function* (factory: Factory) {
    return yield* foremanLocks.withLock(
      factory.id,
      Effect.gen(function* () {
        const existing = yield* foremanRow(factory.id);
        if (existing?.live === true) return existing.threadId;
        const launch = yield* foremanLaunch(factory);
        const threadId = ThreadId.make(`${FACTORY_FOREMAN_THREAD_ID_PREFIX}${yield* randomUuidV4}`);
        // The row lands before the launch, so the first provider session sees the role.
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (existing !== null) {
                yield* Effect.logInfo(
                  "The factory's Foreman thread is archived or deleted, so a new one replaces it.",
                ).pipe(Effect.annotateLogs({ factoryId: factory.id, threadId: existing.threadId }));
                yield* sql`
                  DELETE FROM fork_factory_threads WHERE thread_id = ${existing.threadId}
                `;
              }
              yield* sql`
                INSERT INTO fork_factory_threads (factory_id, thread_id, role, created_at)
                VALUES (${factory.id}, ${threadId}, 'foreman', ${yield* nowIso})
              `;
            }),
          )
          .pipe(Effect.catch(unavailable("written")));
        yield* threadLaunch
          .launch({
            commandId: CommandId.make(`factory-foreman-launch:${threadId}`),
            threadId,
            projectId: factory.projectId,
            title: `Foreman: ${factory.name}`,
            modelSelection: launch.modelSelection,
            runtimeMode: launch.binding.runtimeMode,
            interactionMode: launch.binding.interactionMode,
            workspaceStrategy: launch.workspaceStrategy,
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
        return threadId;
      }),
    );
  });

  const ensureForemanThread = Effect.fn("FactoryService.ensureForemanThread")(function* (
    factoryId: FactoryId,
  ) {
    return yield* ensureForeman(yield* read(factoryId));
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
                WHERE t.work_item_id = w.work_item_id AND t.role = ${filter.role}
              )`,
            ]),
      ])}
      ORDER BY w.created_at DESC, w.rowid DESC
      LIMIT ${WORK_ITEM_LIST_LIMIT}
    `.pipe(NodeSqliteClient.readOnly, Effect.flatMap(decodeWorkItemRows));
    const ids = rows.map((row) => row.id);
    const threadRows =
      ids.length === 0
        ? []
        : yield* sql<{
            readonly workItemId: string;
            readonly threadId: string;
            readonly role: string | null;
          }>`
            SELECT work_item_id AS "workItemId", thread_id AS "threadId", role
            FROM fork_factory_work_item_threads
            WHERE work_item_id IN ${sql.in(ids)}
            ORDER BY created_at, rowid
          `.pipe(NodeSqliteClient.readOnly);
    return rows.map((row): WorkItemSummary => ({
      ...row,
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

  /** One stage change: the item's row, its transition, and any threads it names, together. */
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
          if (input.to !== input.item.stage) {
            yield* sql`
              UPDATE fork_factory_work_items
              SET stage = ${input.to},
                gate_json = ${gateJson},
                updated_at = ${at}
              WHERE work_item_id = ${input.item.id}
            `;
            yield* sql`
              INSERT INTO fork_factory_work_item_transitions (
                transition_id, work_item_id, from_stage, to_stage, actor_json, note, at
              ) VALUES (
                ${transitionId}, ${input.item.id}, ${input.item.stage}, ${input.to},
                ${actorJson}, ${input.note}, ${at}
              )
            `;
          } else if ((input.threads ?? []).length > 0) {
            yield* sql`
              UPDATE fork_factory_work_items SET updated_at = ${at}
              WHERE work_item_id = ${input.item.id}
            `;
          }
          yield* Effect.forEach(
            input.threads ?? [],
            (thread) => sql`
              INSERT INTO fork_factory_work_item_threads (work_item_id, thread_id, role, created_at)
              VALUES (${input.item.id}, ${thread.threadId}, ${thread.role}, ${at})
              ON CONFLICT (work_item_id, thread_id)
              DO UPDATE SET role = COALESCE(excluded.role, fork_factory_work_item_threads.role)
            `,
            { discard: true },
          );
        }),
      )
      .pipe(Effect.catch(ledgerUnavailable));
    return transitionId;
  });

  /** Loads the item under its lock and checks that `callerThreadId` is its Foreman. */
  const withForemanItem = <A, E, R>(
    callerThreadId: ThreadId,
    workItemId: WorkItemId,
    use: (item: WorkItemSummary) => Effect.Effect<A, E, R>,
  ) =>
    workItemLocks.withLock(
      workItemId,
      Effect.gen(function* () {
        const [item] = yield* loadWorkItems({ workItemIds: [workItemId] }).pipe(
          Effect.catch(ledgerUnavailable),
        );
        if (item === undefined) return yield* workItemNotFound(workItemId);
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
        // The same stage only names threads.
        if (
          input.stage !== item.stage &&
          !canTransitionWorkItem(item.stage, input.stage, item.gate)
        ) {
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
          threads: input.threads ?? [],
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

  const foremanUnreachable = workItemUnavailable(
    "The Foreman thread could not be sent the work item.",
  );

  const sendToForeman = (input: ThreadManagementService.ThreadManagementSendInput) =>
    threadManagement.sendToThread(input).pipe(Effect.catch(foremanUnreachable));

  const createWorkItem = Effect.fn("FactoryService.createWorkItem")(function* (
    input: WorkItemCreateInput,
  ) {
    const factory = yield* read(input.factoryId);
    const workItemId = WorkItemId.make(`work-item:${yield* randomUuidV4}`);
    const source: WorkItemSource = { kind: "manual", text: input.text };
    const createdAt = yield* nowIso;
    const sourceJson = yield* encodeSource(source).pipe(Effect.catch(ledgerUnavailable));
    const gateJson = yield* encodeGate({ state: "none" }).pipe(Effect.catch(ledgerUnavailable));
    yield* sql`
      INSERT INTO fork_factory_work_items (
        work_item_id, factory_id, title, source_json, stage, gate_json,
        foreman_thread_id, foreman_run_id, created_at, updated_at
      ) VALUES (
        ${workItemId}, ${factory.id}, ${input.title}, ${sourceJson}, 'new', ${gateJson}, NULL, NULL,
        ${createdAt}, ${createdAt}
      )
    `.pipe(Effect.catch(ledgerUnavailable));

    yield* Effect.gen(function* () {
      const threadId = yield* ensureForeman(factory);
      yield* sql`
        UPDATE fork_factory_work_items SET foreman_thread_id = ${threadId}
        WHERE work_item_id = ${workItemId}
      `.pipe(Effect.catch(ledgerUnavailable));
      const sent = yield* sendToForeman({
        projectId: factory.projectId,
        commandId: CommandId.make(`factory-work-item:${workItemId}`),
        threadId,
        messageId: MessageId.make(`factory-work-item:${workItemId}`),
        text: renderWorkItemMessage({
          workItemId,
          factoryName: factory.name,
          title: input.title,
          source,
        }),
        attachments: [],
        mode: "queue",
        freshContext: true,
        createdBy: "agent",
        creationSource: "server",
      } satisfies freshContext.FreshSendInput);
      yield* sql`
        UPDATE fork_factory_work_items
        SET foreman_run_id = ${sent.run.id}, updated_at = ${yield* nowIso}
        WHERE work_item_id = ${workItemId}
      `.pipe(Effect.catch(ledgerUnavailable));
    }).pipe(
      // The item stays on record as failed, so the person sees what did not start.
      Effect.tapError((error) =>
        workItemLocks
          .withLock(
            workItemId,
            loadWorkItems({ workItemIds: [workItemId] }).pipe(
              Effect.flatMap(([item]) =>
                item === undefined
                  ? Effect.void
                  : moveWorkItem({
                      item,
                      to: "failed",
                      actor: { kind: "server" },
                      note: error.message,
                    }),
              ),
            ),
          )
          .pipe(Effect.ignore({ log: true })),
      ),
    );
    return yield* readWorkItem(workItemId);
  });

  const answerWorkItemGate = Effect.fn("FactoryService.answerWorkItemGate")(function* (
    userId: AuthUserId | null,
    input: WorkItemAnswerGateInput,
  ) {
    const answered = yield* workItemLocks.withLock(
      input.workItemId,
      Effect.gen(function* () {
        const [item] = yield* loadWorkItems({ workItemIds: [input.workItemId] }).pipe(
          Effect.catch(ledgerUnavailable),
        );
        if (item === undefined) return yield* workItemNotFound(input.workItemId);
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
        return { item, question: gate.question, to, transitionId };
      }),
    );
    const { item } = answered;
    const projectId = parseFactoryId(item.factoryId)?.projectId;
    if (item.foremanThreadId !== null && projectId !== undefined) {
      // Steers the item's session when it is running; no fresh context, so the Foreman keeps it.
      yield* sendToForeman({
        projectId,
        commandId: CommandId.make(`factory-gate-answer:${answered.transitionId}`),
        threadId: item.foremanThreadId,
        messageId: MessageId.make(`factory-gate-answer:${answered.transitionId}`),
        text: renderGateAnswerMessage({
          workItemId: item.id,
          question: answered.question,
          decision: input.decision,
          note: input.note,
          stage: answered.to,
        }),
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "server",
      });
    }
    return yield* readWorkItem(input.workItemId);
  });

  const attachDelegatedChild = Effect.fn("FactoryService.attachDelegatedChild")(
    function* (input: {
      readonly parentThreadId: ThreadId;
      readonly parentRunId: RunId;
      readonly childThreadId: ThreadId;
      readonly taskRole: OrchestratorMcpTaskRole | undefined;
    }) {
      const items = yield* sql<{
        readonly workItemId: string;
        readonly foremanRunId: string;
        readonly stage: string;
      }>`
        SELECT work_item_id AS "workItemId", foreman_run_id AS "foremanRunId", stage
        FROM fork_factory_work_items
        WHERE foreman_thread_id = ${input.parentThreadId} AND foreman_run_id IS NOT NULL
      `;
      if (items.length === 0) return;
      // Each item starts a fresh session, so the parent run belongs to the item whose run is the
      // latest fresh one at or before it.
      const { runs } = yield* threadManagement.getThreadRecords(input.parentThreadId, ["runs"]);
      const parentRun = runs.find((run) => run.id === input.parentRunId);
      if (parentRun === undefined) return;
      const sessionStart = runs
        .filter((run) => run.freshContext === true && run.ordinal <= parentRun.ordinal)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      const item = items.find((candidate) => candidate.foremanRunId === sessionStart?.id);
      if (item === undefined || !isWorkItemStage(item.stage) || isTerminalWorkItemStage(item.stage))
        return;
      yield* sql`
        INSERT INTO fork_factory_work_item_threads (work_item_id, thread_id, role, created_at)
        VALUES (
          ${item.workItemId}, ${input.childThreadId}, ${workItemRoleForTask(input.taskRole)},
          ${yield* nowIso}
        )
        ON CONFLICT (work_item_id, thread_id) DO NOTHING
      `;
    },
    Effect.catch((error) =>
      Effect.logWarning("Could not name a delegated task's thread on its work item", {
        errorTag: error._tag,
      }),
    ),
  );

  return FactoryService.of({
    list,
    read,
    save,
    foremanThread,
    ensureForemanThread,
    listWorkItems,
    readWorkItem,
    createWorkItem,
    advanceWorkItem,
    gateWorkItem,
    answerWorkItemGate,
    attachDelegatedChild,
  });
});

export const layer = Layer.effect(FactoryService, make);
