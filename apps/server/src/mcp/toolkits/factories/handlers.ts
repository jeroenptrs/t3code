import { OrchestratorMcpFailure, type WorkItemError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FactoryService from "../../../factories/FactoryService.ts";
import * as FactorySkillStore from "../../../factories/FactorySkillStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertTargetWithinLimits, loadCaller } from "../../threadAccess.ts";
import { FactoriesToolkit } from "./tools.ts";

const notForeman = (error: WorkItemError) =>
  error.code === "not_foreman"
    ? Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message: error.message }))
    : Effect.fail(error);

/** The calling thread, which the service checks is the item's Foreman. */
const callerThreadId = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
  Effect.map((scope) => scope.thread.threadId),
);

const make = Effect.gen(function* () {
  const factories = yield* FactoryService.FactoryService;
  const skills = yield* FactorySkillStore.FactorySkillStore;
  return {
    t3_factory_list: McpToolAccess.reads((input) => factories.list(input.projectId)),
    t3_factory_read: McpToolAccess.reads((input) => factories.read(input.factoryId)),
    // A factory's files decide what its agents run, so saving needs a full-access caller.
    t3_factory_save: McpToolAccess.writesEnvironment((input) => factories.save(input)),
    t3_factory_skill_list: McpToolAccess.reads((input) => skills.list(input)),
    t3_factory_skill_read: McpToolAccess.reads((input) => skills.read(input)),
    // A skill goes into every role that binds it, so writing one needs a full-access caller.
    t3_factory_skill_save: McpToolAccess.writesEnvironment(({ file, ...target }) =>
      file === null
        ? skills.delete(target)
        : skills.save({ ...target, body: file.body }).pipe(Effect.as(target)),
    ),
    t3_work_item_list: McpToolAccess.reads((input) => factories.listWorkItems(input)),
    t3_work_item_read: McpToolAccess.reads((input) => factories.readWorkItem(input.workItemId)),
    // The Foreman runs in its role's modes, so a caller below them cannot start its work.
    t3_work_item_create: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const factory = yield* factories.read(input.factoryId);
        const foreman = factory.roles.find((role) => role.role === "foreman");
        if (foreman !== undefined) {
          yield* assertTargetWithinLimits((yield* loadCaller()).limits, foreman.binding);
        }
        return yield* factories.createWorkItem(input);
      }),
    ),
    t3_work_item_advance: McpToolAccess.actsAsCaller((input) =>
      callerThreadId.pipe(
        Effect.flatMap((threadId) => factories.advanceWorkItem(threadId, input)),
        Effect.catchTags({ WorkItemError: notForeman }),
      ),
    ),
    t3_work_item_gate: McpToolAccess.actsAsCaller((input) =>
      callerThreadId.pipe(
        Effect.flatMap((threadId) => factories.gateWorkItem(threadId, input)),
        Effect.catchTags({ WorkItemError: notForeman }),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof FactoriesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FactoriesToolkit, make);
