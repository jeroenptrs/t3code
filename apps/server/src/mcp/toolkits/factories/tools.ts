import {
  Factory,
  FactoryError,
  FactoryId,
  FactoryListInput,
  FactoryListResult,
  FactoryReadInput,
  FactorySaveInput,
  OrchestratorMcpFailure,
  WorkItem,
  WorkItemAdvanceInput,
  WorkItemCreateInput,
  WorkItemError,
  WorkItemGateInput,
  WorkItemListResult,
  WorkItemReadInput,
  WorkItemStage,
  WorkItemTransitionError,
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

const workItemShared = {
  ...shared,
  failure: Schema.Union([
    OrchestratorMcpFailure,
    FactoryError,
    WorkItemError,
    WorkItemTransitionError,
  ]),
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

const WorkItemListTool = Tool.make("t3_work_item_list", {
  ...workItemShared,
  description:
    "List work items, newest first: stage, gate, and threads. Omit factoryId for every factory's.",
  parameters: Schema.Struct({
    factoryId: Schema.optionalKey(FactoryId),
    stage: Schema.optionalKey(WorkItemStage),
  }),
  success: WorkItemListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WorkItemReadTool = Tool.make("t3_work_item_read", {
  ...workItemShared,
  description: "Read one work item: request, stage, gate, threads, and every stage change.",
  parameters: WorkItemReadInput,
  success: WorkItem,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WorkItemCreateTool = Tool.make("t3_work_item_create", {
  ...workItemShared,
  description:
    "Send a request to a factory as a new work item. Its Foreman thread gets it in a fresh session.",
  parameters: WorkItemCreateInput,
  success: WorkItem,
}).annotate(Tool.Destructive, false);

const WorkItemAdvanceTool = Tool.make("t3_work_item_advance", {
  ...workItemShared,
  description:
    "Foreman only. Move your work item to a stage, naming in `threads` each child that worked on it. The same stage only adds threads.",
  parameters: WorkItemAdvanceInput,
  success: WorkItem,
}).annotate(Tool.Destructive, false);

const WorkItemGateTool = Tool.make("t3_work_item_gate", {
  ...workItemShared,
  description:
    "Foreman only. Hold your work item for a person's decision, then end your turn. The answer arrives as your next message: approval resumes at `resumeStage`, rejection drops the item.",
  parameters: WorkItemGateInput,
  success: WorkItem,
}).annotate(Tool.Destructive, false);

export const FactoriesToolkit = Toolkit.make(
  FactoryListTool,
  FactoryReadTool,
  FactorySaveTool,
  WorkItemListTool,
  WorkItemReadTool,
  WorkItemCreateTool,
  WorkItemAdvanceTool,
  WorkItemGateTool,
);
