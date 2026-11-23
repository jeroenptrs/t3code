import * as Effect from "effect/Effect";

import * as FactoryService from "../../../factories/FactoryService.ts";
import * as FactorySkillStore from "../../../factories/FactorySkillStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../../delegatedTaskModes.ts";
import { loadCaller } from "../../threadAccess.ts";
import { FactoriesToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const factories = yield* FactoryService.FactoryService;
  const skills = yield* FactorySkillStore.FactorySkillStore;
  return {
    t3_factory_list: McpToolAccess.reads((input) => factories.list(input.projectId)),
    t3_factory_read: McpToolAccess.reads((input) => factories.read(input.factoryId)),
    // A factory's files decide what its agents run, so saving needs a full-access caller.
    t3_factory_save: McpToolAccess.writesEnvironment((input) => factories.save(input)),
    t3_factory_delete: McpToolAccess.writesEnvironment((input) =>
      factories.delete(input.factoryId),
    ),
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
          const { limits } = yield* loadCaller();
          yield* resolveRuntimeMode(limits.runtimeMode, foreman.binding.runtimeMode);
          yield* resolveInteractionMode(limits.interactionMode, foreman.binding.interactionMode);
        }
        return yield* factories.createWorkItem(input);
      }),
    ),
    // MCP calls carry no user, so the log records no one, as for the admin dev credential.
    t3_work_item_dismiss_failure: McpToolAccess.writesWithCapability((input) =>
      factories.setWorkItemFailureDismissed(null, input),
    ),
    // The delegate_task path, with the role it names; the service checks the caller is the Foreman.
    t3_factory_delegate: McpToolAccess.actsAsCaller(({ workItemId, role, ...task }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* orchestrator
          .delegateTask(scope, task)
          .pipe(Effect.provideService(FactoryService.FactoryDelegationRole, { workItemId, role }));
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof FactoriesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FactoriesToolkit, make);
