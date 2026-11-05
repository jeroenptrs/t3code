// Adapts upstream pingdotgg/t3code#30323 (fresh provider sessions on send) and the pingdotgg/t3code#30325 server slice.
import type { ExecutionEnvironmentCapabilities, OrchestrationV2Command } from "@t3tools/contracts";

import type { ThreadManagementSendInput } from "../../orchestration-v2/ThreadManagementService.ts";

export type FreshSendInput = ThreadManagementSendInput & { readonly freshContext: true };

export type MessageDispatchFreshContext = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>["freshContext"];

export const FRESH_CONTEXT_CAPABILITY =
  "freshContext" satisfies keyof ExecutionEnvironmentCapabilities;
