import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  SCHEDULED_AUTOMATION_WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopesForRpcMethod } from "../auth/RpcAuthorization.ts";

describe("scheduled automation RPC", () => {
  it("registers command, read, and snapshot-plus-change stream methods", () => {
    for (const method of Object.values(SCHEDULED_AUTOMATION_WS_METHODS)) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("maps mutations to read plus operate and observations to read", () => {
    expect(requiredScopesForRpcMethod(SCHEDULED_AUTOMATION_WS_METHODS.dispatchCommand)).toEqual([
      AuthOrchestrationOperateScope,
      AuthOrchestrationReadScope,
    ]);
    for (const method of [
      SCHEDULED_AUTOMATION_WS_METHODS.list,
      SCHEDULED_AUTOMATION_WS_METHODS.get,
      SCHEDULED_AUTOMATION_WS_METHODS.subscribe,
    ]) {
      expect(requiredScopesForRpcMethod(method)).toEqual([AuthOrchestrationReadScope]);
    }
  });
});
