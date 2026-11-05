import * as Effect from "effect/Effect";

import * as FactoryService from "../../../factories/FactoryService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FactoriesToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const factories = yield* FactoryService.FactoryService;
  return {
    t3_factory_list: McpToolAccess.reads((input) => factories.list(input.projectId)),
    t3_factory_read: McpToolAccess.reads((input) => factories.read(input.factoryId)),
    // A factory's files decide what its agents run, so saving needs a full-access caller.
    t3_factory_save: McpToolAccess.writesEnvironment((input) => factories.save(input)),
  } satisfies McpToolAccess.Handlers<typeof FactoriesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FactoriesToolkit, make);
