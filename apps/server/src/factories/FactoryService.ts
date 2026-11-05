/**
 * Fork-only software factories (docs/internals/factories.md). Reads and writes each factory's
 * definition files in its project's checkout, and reports what the factory owns and what of that
 * needs a person.
 */
import {
  type Factory,
  type FactoryAttention,
  type FactoryDefinition,
  FactoryError,
  type FactoryId,
  type FactoryIssue,
  type FactoryListResult,
  FactoryName,
  type FactoryProject,
  type FactoryRole,
  FactoryRoleName,
  type FactoryRolePath,
  type FactorySaveInput,
  type FactoryThread,
  makeFactoryId,
  parseFactoryId,
  type ProjectId,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import {
  bindingIssues,
  defaultRolePath,
  effectiveBinding,
  FACTORY_FILE_NAME,
  parseFactoryJson,
  parseRoleFile,
  renderFactoryJson,
  renderRoleFile,
  resolveProjects,
} from "./factoryFiles.ts";
import { builtinRoles } from "./roles/index.ts";

const FACTORIES_DIRECTORY = [".t3", "factories"] as const;
const ROLE_NAMES = FactoryRoleName.literals;
const isFactoryName = Schema.is(FactoryName);
const isRoleName = Schema.is(FactoryRoleName);

export class FactoryService extends Context.Service<
  FactoryService,
  {
    /** Every factory in this environment's projects, or in one project. */
    readonly list: (projectId?: ProjectId) => Effect.Effect<FactoryListResult, FactoryError>;
    readonly read: (factoryId: FactoryId) => Effect.Effect<Factory, FactoryError>;
    /** Refuses invalid role bindings; names and role paths are already checked by the schema. */
    readonly save: (input: FactorySaveInput) => Effect.Effect<Factory, FactoryError>;
  }
>()("t3/factories/FactoryService") {}

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
    if (rolePath === undefined) return { role: builtinRole(role, null), issues: [] };
    const text = yield* readText(path.join(directory, rolePath));
    if (Option.isNone(text)) {
      return {
        role: builtinRole(role, rolePath),
        issues: [
          {
            code: "missing_role_file",
            role,
            field: null,
            message: `${rolePath} does not exist, so ${role} uses its built-in default.`,
          } satisfies FactoryIssue,
        ],
      };
    }
    const parsed = parseRoleFile(role, text.value);
    const binding = effectiveBinding(builtinRoles[role].binding, parsed.binding);
    return {
      role: {
        role,
        path: rolePath,
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
   * Owned threads: those the factory started for a role, and those its scheduled tasks sent work
   * into, which their messages record. Deleted threads are left out.
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
      let failedRuns = 0;
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
          gatesWaiting: 0,
          failedRuns,
          questions,
          total: failedRuns + questions,
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

  return FactoryService.of({ list, read, save });
});

export const layer = Layer.effect(FactoryService, make);
