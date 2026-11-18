import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

/** The model a role runs, by its name where the provider lists it. */
export function factoryModelLabel(
  model: ModelSelection | null,
  providers: ReadonlyArray<{
    readonly instanceId: ServerProvider["instanceId"];
    readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  }>,
  resolve: MessageResolver = m,
): string {
  if (model === null) return resolve(msg("Project default", { $context: "model" }));
  const provider = providers.find((candidate) => candidate.instanceId === model.instanceId);
  return provider?.models.find((candidate) => candidate.slug === model.model)?.name ?? model.model;
}
