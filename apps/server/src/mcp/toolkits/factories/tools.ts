import {
  Factory,
  FactoryError,
  FactoryListInput,
  FactoryListResult,
  FactoryReadInput,
  FactorySaveInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, FactoryError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const FactoryListTool = Tool.make("t3_factory_list", {
  ...shared,
  description:
    "List software factories (`.t3/factories/<name>/` in each project), or one project's: ids, owned thread and scheduled task ids, issue count, attention count.",
  parameters: FactoryListInput,
  success: FactoryListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FactoryReadTool = Tool.make("t3_factory_read", {
  ...shared,
  description:
    "Read one factory: definition, each role's effective binding and instructions with their source (builtin or file), validation issues, owned threads and scheduled tasks.",
  parameters: FactoryReadInput,
  success: Factory,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FactorySaveTool = Tool.make("t3_factory_save", {
  ...shared,
  description:
    "Write a factory's `factory.json` and the role files you pass; creates it if new. A passed file replaces the whole role file, body included. Omitted roles keep their files; `file: null` deletes one so the built-in role applies. A binding the provider lacks fails with `issues`.",
  parameters: FactorySaveInput,
  success: Factory,
}).annotate(Tool.Destructive, true);

export const FactoriesToolkit = Toolkit.make(FactoryListTool, FactoryReadTool, FactorySaveTool);
