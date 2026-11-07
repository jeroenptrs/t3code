import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as WorkItemSink from "../scheduledTasks/WorkItemSink.ts";
import * as FactoryService from "./FactoryService.ts";

/**
 * FactoryService needs ScheduledTaskService, which is built first and reads the sink when it is
 * built, so the sink reaches the factories through this slot that `layerRegister` fills.
 */
class FactoryServiceSlot extends Context.Service<
  FactoryServiceSlot,
  Ref.Ref<Option.Option<FactoryService.FactoryService["Service"]>>
>()("t3/factories/FactoryWorkItemSink/FactoryServiceSlot") {}

const layerSlot = Layer.effect(FactoryServiceSlot, Ref.make(Option.none()));

/** Give the same instance to the scheduled task runner and to `layerRegister`. */
export const layer = Layer.effect(
  WorkItemSink.WorkItemSink,
  Effect.gen(function* () {
    const slot = yield* FactoryServiceSlot;
    return WorkItemSink.WorkItemSink.of({
      create: Effect.fn("FactoryWorkItemSink.create")(function* (input) {
        const factories = yield* Ref.get(slot);
        if (Option.isNone(factories)) {
          return yield* Effect.fail({ message: "Factories are not running on this server yet." });
        }
        yield* factories.value.createWorkItemFromTrigger(input);
      }),
    });
  }),
).pipe(Layer.provideMerge(layerSlot));

export const layerRegister = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* FactoryServiceSlot;
    yield* Ref.set(slot, Option.some(yield* FactoryService.FactoryService));
  }),
);
