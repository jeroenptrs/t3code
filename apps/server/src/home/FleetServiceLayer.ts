/**
 * FleetServiceLayer - FleetService's implementation, apart from its tag so the
 * MCP tools that depend on the tag never import the MCP service it reuses.
 *
 * @module FleetServiceLayer
 */
import {
  CommandId,
  type FleetActor,
  type FleetInput,
  type FleetInvokeInput,
  type FleetOperation,
  type FleetResult,
  isHomeLaunchedThreadId,
  ProviderRequestKind,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { threadLinkFor } from "../mcp/McpInvocationContext.ts";
import {
  agentStopReason,
  listItemFromShell,
  providerCapabilities,
  readThreadPage,
  threadManagementFailure,
  threadSettlement,
} from "../mcp/OrchestratorMcpService.ts";
import { resultFromThread } from "../mcp/ThreadMetadataMcpService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";

import { FleetService, refuseHomeFolder } from "./FleetService.ts";

const DEFAULT_LIST_LIMIT = 50;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const orchestrationError = (error: unknown) =>
  failure(
    "orchestration_error",
    error instanceof Error ? error.message : "The operation could not be completed.",
  );

type Handlers = {
  readonly [Op in FleetOperation]: (
    input: FleetInput<Op>,
    actor: FleetActor,
  ) => Effect.Effect<FleetResult<Op>, OrchestratorMcpFailure>;
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const random = yield* SecureRandom.SecureRandom;
  // Links in results point at this environment, wherever the call came from.
  const linkScope = {
    environmentId: (yield* environment.getDescriptor).environmentId,
    client: undefined,
  };

  // A retried request with the same clientRequestId maps to the same command
  // for the same target thread; another target gets its own command.
  const commandId = (
    actor: FleetActor,
    operation: string,
    target?: { readonly threadId: ThreadId; readonly clientRequestId?: string | undefined },
  ) =>
    (target?.clientRequestId === undefined
      ? random.uuidV4()
      : Effect.succeed(
          `${actor.environmentId}:${actor.threadId}:${target.threadId}:${target.clientRequestId}`,
        )
    ).pipe(Effect.map((key) => CommandId.make(`fleet:${operation}:${key}`)));

  const loadShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(threadManagementFailure),
      Effect.filterOrFail(
        (shell): shell is OrchestrationV2ThreadShell => shell !== null && shell.deletedAt === null,
        () => failure("thread_not_found", `Thread ${threadId} was not found.`),
      ),
    );

  const requireThreadId = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.fail(failure("invalid_request", "threadId is required in another environment."))
      : Effect.succeed(threadId);

  const dispatch = (command: OrchestrationV2Command) =>
    threads.dispatch(command).pipe(
      Effect.map((result) => ({ sequence: result.sequence })),
      Effect.mapError(threadManagementFailure),
    );

  const loadRequests = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
        turnItemTypes: ["user_input_request", "approval_request"],
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const handlers: Handlers = {
    capabilities: Effect.fn("FleetService.capabilities")(function* (
      input: FleetInput<"capabilities">,
    ) {
      const current = yield* settings.getSettings.pipe(Effect.mapError(orchestrationError));
      return {
        providers: providerCapabilities({
          providers: yield* providerRegistry.getProviders,
          orchestrationCapableInstanceIds: new Set<string>(yield* adapters.list()),
          settings: current,
          projectId: null,
          inherited: undefined,
          searchTerms: input.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [],
        }),
      };
    }),

    "projects.list": (input) =>
      projects
        .listPage({ cursor: input.cursor ?? 0, limit: input.limit ?? 20 })
        .pipe(Effect.mapError(orchestrationError)),

    "threads.list": Effect.fn("FleetService.threads.list")(function* (
      input: FleetInput<"threads.list">,
      actor: FleetActor,
    ) {
      // Home lists every project when it names none.
      const entries = yield* threads
        .listProjectThreads({
          projectId: input.projectId,
          includeSubagents: input.includeSubagents !== false,
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const nowMs = yield* Clock.currentTimeMillis;
      // An empty list is no filter: clients that fill every optional field send `[]`.
      const statuses =
        input.statuses === undefined || input.statuses.length === 0
          ? null
          : new Set(input.statuses);
      const titleContains = input.titleContains?.toLocaleLowerCase();
      const candidates = entries.filter(
        (thread) =>
          (input.settled === undefined || threadSettlement(thread).settled === input.settled) &&
          (titleContains === undefined ||
            thread.title.toLocaleLowerCase().includes(titleContains)) &&
          // Only a snooze that ends later can hold, so the rest skip building a shell.
          (input.snoozed !== true ||
            (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)),
      );
      // Shells are the costly part, so build them only for the threads the page needs.
      const shellsOf = (list: ReadonlyArray<{ readonly id: ThreadId }>) =>
        list.length === 0
          ? Effect.succeed([])
          : threads
              .getShellSnapshot({ location: "active", threadIds: list.map(({ id }) => id) })
              .pipe(
                Effect.map((snapshot) => {
                  const shellsById = new Map(snapshot.threads.map((shell) => [shell.id, shell]));
                  return list.flatMap(({ id }) => shellsById.get(id) ?? []);
                }),
                Effect.mapError(threadManagementFailure),
              );
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      let listed: ReadonlyArray<{ readonly id: ThreadId }>;
      let page: ReadonlyArray<OrchestrationV2ThreadShell>;
      if (statuses === null && input.snoozed === undefined) {
        listed = candidates;
        page = yield* shellsOf(candidates.slice(cursor, cursor + limit));
      } else {
        // Status and snooze state are derived from the shell.
        const filtered = (yield* shellsOf(candidates)).filter(
          (thread) =>
            (statuses === null || statuses.has(thread.activityRunStatus ?? thread.status)) &&
            (input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed),
        );
        listed = filtered;
        page = filtered.slice(cursor, cursor + limit);
      }
      const next = cursor + limit;
      return {
        projectId: input.projectId ?? null,
        currentThreadId: listed.some((thread) => thread.id === actor.threadId)
          ? actor.threadId
          : null,
        threads: page.map((shell) => listItemFromShell(linkScope, shell, nowMs)),
        nextCursor: next < listed.length ? next : null,
        total: listed.length,
      };
    }),

    "threads.read": Effect.fn("FleetService.threads.read")(function* (
      input: FleetInput<"threads.read">,
    ) {
      const shell = yield* loadShell(input.threadId);
      const target = yield* threads
        .getProjectThreadRecords({ projectId: shell.projectId, threadId: input.threadId }, [
          "runs",
          "runtimeRequests",
          "providerTurns",
        ])
        .pipe(Effect.mapError(threadManagementFailure));
      // Home is an agent, so it reads newest first like one.
      return (yield* readThreadPage(threads, linkScope, target, shell, input, true)).result;
    }),

    "threads.launch": Effect.fn("FleetService.threads.launch")(function* (
      input: FleetInput<"threads.launch">,
      actor: FleetActor,
    ) {
      // Home picks the id so its watch exists first; no caller may pick another kind of id.
      if (input.threadId !== undefined && !isHomeLaunchedThreadId(input.threadId)) {
        return yield* failure("invalid_request", "A launched thread id must be a Home launch id.");
      }
      if (
        input.scratch === true &&
        (input.projectId !== undefined || input.workspaceStrategy !== undefined)
      ) {
        return yield* failure(
          "invalid_request",
          "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
        );
      }
      const projectId =
        input.scratch === true
          ? (yield* folders.ensureScratchProject.pipe(Effect.mapError(orchestrationError)))
              .projectId
          : input.projectId;
      if (projectId === undefined) {
        return yield* failure("invalid_request", "Pass projectId or scratch:true.");
      }
      yield* refuseHomeFolder(
        { projects, folders },
        { projectId, workspaceStrategy: input.workspaceStrategy },
      );
      // Home has no thread here, so it starts with the project's defaults, as a client does.
      const current = yield* settings.getSettings.pipe(Effect.mapError(orchestrationError));
      const project = yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(orchestrationError), Effect.map(Option.getOrUndefined));
      const defaults = resolveProjectSettings(current, projectId, project).settings;
      const modelSelection =
        input.modelSelection ??
        resolveNewThreadModelSelection({
          defaultSelection: defaults.defaultModelSelection,
          fallbackSelection: defaults.fallbackModelSelection,
          providers: yield* providerRegistry.getProviders,
          settings: defaults,
          projectId,
          now: DateTime.toEpochMillis(yield* DateTime.now),
        }).selection;
      if (modelSelection === null) {
        return yield* failure(
          "invalid_request",
          "Pass modelSelection; this environment has no default model.",
        );
      }
      // A retried launch reuses the hub's thread id, and with it the same command.
      const id =
        input.threadId === undefined
          ? yield* commandId(actor, "launch")
          : CommandId.make(`fleet:launch:${input.threadId}`);
      const messageId = MessageId.make(id);
      const result = yield* launches
        .launch({
          commandId: id,
          threadId: input.threadId ?? ThreadId.make(id),
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode: input.runtimeMode ?? defaults.defaultRuntimeMode,
          interactionMode: input.interactionMode ?? "default",
          workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
          ...(input.message === undefined
            ? {}
            : {
                initialMessage: {
                  messageId,
                  senderThreadId: actor.threadId,
                  text: input.message,
                  attachments: [],
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(orchestrationError));
      const thread = result.projection.thread;
      const run = result.projection.runs.find((candidate) => candidate.userMessageId === messageId);
      return {
        threadId: thread.id,
        link: threadLinkFor(linkScope, thread.id),
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        runId: run?.id ?? null,
        status: run?.status ?? null,
      };
    }),

    "threads.send": Effect.fn("FleetService.threads.send")(function* (
      input: FleetInput<"threads.send">,
      actor: FleetActor,
    ) {
      const shell = yield* loadShell(input.threadId);
      const id = yield* commandId(actor, "send", input);
      const messageId = MessageId.make(id);
      const result = yield* threads
        .sendToThread({
          projectId: shell.projectId,
          commandId: id,
          threadId: input.threadId,
          senderThreadId: actor.threadId,
          messageId,
          text: input.message,
          attachments: [],
          mode: input.mode ?? "auto",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(threadManagementFailure));
      return {
        threadId: input.threadId,
        link: threadLinkFor(linkScope, input.threadId),
        messageId,
        runId: result.run.id,
        ...(result.run.delegatedTaskId === undefined ? {} : { taskId: result.run.delegatedTaskId }),
        status: result.run.status,
        delivery: result.delivery,
      };
    }),

    "threads.interrupt": Effect.fn("FleetService.threads.interrupt")(function* (
      input: FleetInput<"threads.interrupt">,
      actor: FleetActor,
    ) {
      const shell = yield* loadShell(input.threadId);
      const id = yield* commandId(actor, "interrupt", input);
      // Like the thread's Stop button: interrupt, hold the queue, stop delegated tasks.
      if (input.stop === true) {
        const stopped = yield* threads
          .dispatch({
            type: "thread.stop",
            commandId: id,
            threadId: input.threadId,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          .pipe(Effect.mapError(threadManagementFailure));
        // A retry with the same clientRequestId repeats only the stops that failed.
        yield* threads
          .stopDelegatedTasks({ threadId: input.threadId, commandId: id, reason: input.reason })
          .pipe(Effect.mapError(threadManagementFailure));
        // As in t3_thread_interrupt: the run this stop interrupted, from its own events.
        const interrupted = stopped.storedEvents.find(
          ({ event }) =>
            (event.type === "run.updated" && event.payload.status === "interrupted") ||
            (event.type === "turn-item.updated" &&
              event.payload.type === "run_interrupt_request" &&
              event.payload.providerTurnId !== null),
        )?.event.runId;
        return {
          threadId: input.threadId,
          runId: interrupted ?? null,
          status: interrupted === undefined ? "no_active_run" : "interrupt_requested",
        };
      }
      const result = yield* threads
        .interruptThread({
          projectId: shell.projectId,
          commandId: id,
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          reason: agentStopReason(input.reason),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      if (result.type === "no_active_run") {
        return { threadId: input.threadId, runId: null, status: "no_active_run" as const };
      }
      return {
        threadId: input.threadId,
        runId: result.run.id,
        status:
          result.type === "already_terminal" ? result.run.status : ("interrupt_requested" as const),
      };
    }),

    "threads.organize": Effect.fn("FleetService.threads.organize")(function* (
      input: FleetInput<"threads.organize">,
      actor: FleetActor,
    ) {
      const threadId = yield* requireThreadId(input.threadId);
      yield* loadShell(threadId);
      const common = { commandId: yield* commandId(actor, "organize"), threadId };
      switch (input.action) {
        case "settle":
          return yield* threads
            .settleThread({ ...common, byOwnAgent: threadId === actor.threadId })
            .pipe(Effect.mapError(threadManagementFailure));
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* failure("invalid_request", "snooze requires snoozedUntil.");
          }
          return yield* dispatch({
            ...common,
            type: "thread.snooze",
            snoozedUntil: input.snoozedUntil,
          });
        case "unsnooze":
        case "unsettle":
          return yield* dispatch({ ...common, type: `thread.${input.action}`, reason: "user" });
        case "mark_unread":
          return yield* dispatch({ ...common, type: "thread.mark-unread" });
        default:
          return yield* dispatch({ ...common, type: `thread.${input.action}` });
      }
    }),

    "threads.rename": Effect.fn("FleetService.threads.rename")(function* (
      input: FleetInput<"threads.rename">,
      actor: FleetActor,
    ) {
      yield* loadShell(input.threadId);
      const id = yield* commandId(actor, "rename", input);
      const dispatched = yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: id,
          threadId: input.threadId,
          title: input.title,
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const updated = dispatched.storedEvents.find(
        (stored) => stored.event.type === "thread.metadata-updated",
      );
      // A retry may find its stored events compacted away; answer from the projection.
      const thread =
        updated?.event.type === "thread.metadata-updated"
          ? updated.event.payload
          : yield* loadShell(input.threadId);
      return resultFromThread({
        action: "rename",
        commandId: id,
        sequence: dispatched.sequence,
        thread,
      });
    }),

    "requests.list": Effect.fn("FleetService.requests.list")(function* (
      input: FleetInput<"requests.list">,
    ) {
      const threadId = yield* requireThreadId(input.threadId);
      const { runtimeRequests } = yield* loadRequests(threadId);
      const pending = runtimeRequests.filter((request) => request.status === "pending");
      return {
        requestIds: pending
          .filter((request) => request.kind === "user_input")
          .map((request) => request.id),
        approvalRequestIds: pending
          .filter((request) => isApprovalKind(request.kind))
          .map((request) => request.id),
      };
    }),

    "requests.read": Effect.fn("FleetService.requests.read")(function* (
      input: FleetInput<"requests.read">,
    ) {
      const threadId = yield* requireThreadId(input.threadId);
      const { runtimeRequests, turnItems } = yield* loadRequests(threadId);
      const request = runtimeRequests.find(
        (candidate) => candidate.id === input.requestId && candidate.status === "pending",
      );
      const item = turnItems.find(
        (candidate) =>
          (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
          candidate.requestId === input.requestId,
      );
      if (request === undefined || item === undefined) {
        return yield* failure("invalid_request", "The pending request was not found.");
      }
      if (item.type === "user_input_request") {
        return {
          requestId: input.requestId,
          kind: "question" as const,
          questions: item.questions,
        };
      }
      if (item.type !== "approval_request") {
        return yield* failure("invalid_request", "The pending request was not found.");
      }
      return {
        requestId: input.requestId,
        kind: "approval" as const,
        questions: [],
        approval: {
          requestKind: item.requestKind,
          prompt: item.prompt ?? null,
          appName: item.appName ?? null,
          options: item.options ?? [],
        },
      };
    }),

    "requests.respond": Effect.fn("FleetService.requests.respond")(function* (
      input: FleetInput<"requests.respond">,
      actor: FleetActor,
    ) {
      const threadId = yield* requireThreadId(input.threadId);
      const { runtimeRequests } = yield* loadRequests(threadId);
      const request = runtimeRequests.find(
        (candidate) => candidate.id === input.requestId && candidate.status === "pending",
      );
      if (request === undefined) {
        return yield* failure("invalid_request", "The pending request was not found.");
      }
      const isQuestion = request.kind === "user_input";
      // Tool calls and auth refreshes are answered by the runtime, never by a decision.
      if (!isQuestion && !isApprovalKind(request.kind)) {
        return yield* failure(
          "invalid_request",
          "This request does not take an answer or decision.",
        );
      }
      if (isQuestion ? input.answers === undefined : input.decision === undefined) {
        return yield* failure(
          "invalid_request",
          isQuestion ? "A question needs answers." : "An approval needs a decision.",
        );
      }
      return yield* dispatch({
        type: "runtime-request.respond",
        commandId: yield* commandId(actor, "respond"),
        threadId,
        requestId: input.requestId,
        ...(isQuestion ? { answers: input.answers } : { decision: input.decision }),
      });
    }),
  };

  // Each handler takes its own operation's input; the request union keeps them paired.
  const run = (request: FleetInvokeInput["request"], actor: FleetActor) =>
    (
      handlers[request.op] as (
        input: never,
        actor: FleetActor,
      ) => Effect.Effect<unknown, OrchestratorMcpFailure>
    )(request.input as never, actor);

  return FleetService.of({
    execute: Effect.fn("FleetService.execute")(function* ({ actor, request }: FleetInvokeInput) {
      yield* Effect.annotateCurrentSpan({ "fleet.op": request.op });
      return yield* run(request, actor);
    }),
  });
});

/** Approval requests take a decision; other provider requests do not. */
const isApprovalKind = Schema.is(ProviderRequestKind);

export const layer = Layer.effect(FleetService, make);
