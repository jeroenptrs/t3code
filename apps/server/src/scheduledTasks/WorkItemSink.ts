import type { FactoryId, WorkItemTriggerSource } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Where a trigger with a work item target sends its runs. A port, so the scheduled task runner
 * creates work items without importing the factories module, which imports it. The error's
 * message is shown on the trigger.
 */
export class WorkItemSink extends Context.Service<
  WorkItemSink,
  {
    readonly create: (input: {
      readonly factoryId: FactoryId;
      readonly title: string;
      readonly source: WorkItemTriggerSource;
    }) => Effect.Effect<void, { readonly message: string }>;
  }
>()("t3/scheduledTasks/WorkItemSink") {}
