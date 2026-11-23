import {
  Factory,
  FactoryDeleteInput,
  FactoryDeleteResult,
  FactoryError,
  FactoryId,
  FactoryListInput,
  FactoryListResult,
  FactoryReadInput,
  FactorySaveInput,
  FactorySkillError,
  FactorySkillLevel,
  FactorySkillListInput,
  FactorySkillListResult,
  FactorySkillName,
  FactorySkillReadInput,
  FactorySkillReadResult,
  FactorySkillSaveInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  WorkItem,
  WorkItemCreateInput,
  WorkItemDelegateInput,
  WorkItemDismissFailureInput,
  WorkItemError,
  WorkItemListResult,
  WorkItemReadInput,
  WorkItemStage,
  WorkItemTransitionError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, FactoryError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const skillShared = {
  ...shared,
  failure: Schema.Union([OrchestratorMcpFailure, FactorySkillError]),
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
    "Write a factory's `factory.json` and the role files you pass; creates it if new. `definition.roles` lists every role besides the Foreman (path, or null for none); leaving one out removes it. A passed file replaces the whole role file, body included; `file: null` deletes one so the role's defaults apply. Start a new role from `rolePresets` in t3_factory_read. Invalid input fails with `issues`. Skills: t3_factory_skill_save.",
  parameters: FactorySaveInput,
  success: Factory,
}).annotate(Tool.Destructive, true);

const FactoryDeleteTool = Tool.make("t3_factory_delete", {
  ...shared,
  description:
    "Delete a factory's directory and work items; its threads return to Home and its scheduled tasks stay.",
  parameters: FactoryDeleteInput,
  success: FactoryDeleteResult,
}).annotate(Tool.Destructive, true);

const FactorySkillListTool = Tool.make("t3_factory_skill_list", {
  ...skillShared,
  description:
    "List skills roles can bind, with source and description. Without factoryId: home and built-in skills. A factory skill replaces a home one of the same name, which replaces a built-in one.",
  parameters: FactorySkillListInput,
  success: FactorySkillListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FactorySkillReadTool = Tool.make("t3_factory_skill_read", {
  ...skillShared,
  description: "Read a skill's SKILL.md at one level: builtin, home, or factory (needs factoryId).",
  parameters: FactorySkillReadInput,
  success: FactorySkillReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FactorySkillSaveTool = Tool.make("t3_factory_skill_save", {
  ...skillShared,
  description:
    "Write a skill's whole SKILL.md at home (every project on this server) or in a factory (needs factoryId). Use this, not file edits, for these skills. Frontmatter `name` must match. `file: null` deletes it so the lower level applies.",
  parameters: Schema.Struct({
    name: FactorySkillName,
    source: FactorySkillLevel,
    factoryId: Schema.optionalKey(FactoryId),
    file: Schema.NullOr(Schema.Struct({ body: FactorySkillSaveInput.fields.body })),
  }),
  success: Schema.Struct({ name: FactorySkillName, source: FactorySkillLevel }),
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
    "Send a request to a factory as a new work item. It starts at once in a Foreman thread of its own.",
  parameters: WorkItemCreateInput,
  success: WorkItem,
}).annotate(Tool.Destructive, false);

const FactoryDelegateTool = Tool.make("t3_factory_delegate", {
  ...shared,
  failure: OrchestratorMcpFailure,
  dependencies: [...shared.dependencies, OrchestratorMcpService.OrchestratorMcpService],
  description:
    "Foreman only. Start one child for your work item as one of the factory's enabled roles, with only `task`. The role sets its model, modes, checkout, skills, and the result it returns. Children run at once: call it again for another part or another role. Use it, not delegate_task. Read a finished child's `output` from `task_status`; `summary` is its prose.",
  parameters: WorkItemDelegateInput,
  success: OrchestratorMcpDelegateTaskResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const WorkItemDismissFailureTool = Tool.make("t3_work_item_dismiss_failure", {
  ...workItemShared,
  description:
    "Dismiss a failed work item's failure so it stops asking for attention; `dismissed: false` restores it.",
  parameters: WorkItemDismissFailureInput,
  success: WorkItem,
}).annotate(Tool.Destructive, false);

export const FactoriesToolkit = Toolkit.make(
  FactoryListTool,
  FactoryReadTool,
  FactorySaveTool,
  FactoryDeleteTool,
  FactorySkillListTool,
  FactorySkillReadTool,
  FactorySkillSaveTool,
  WorkItemListTool,
  WorkItemReadTool,
  WorkItemCreateTool,
  FactoryDelegateTool,
  WorkItemDismissFailureTool,
);
