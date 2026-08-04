import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentAuthorizationError,
  SCHEDULED_AUTOMATION_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  authorizeRpcEffectForScopes,
  RPC_REQUIRED_SCOPES,
  requiredScopesForRpcMethod,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares required scopes for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopesForRpcMethod(WS_METHODS.serverReportClientActivity)).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(requiredScopesForRpcMethod(WS_METHODS.serverReportHostPowerState)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(requiredScopesForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(requiredScopesForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toEqual([
      AuthOrchestrationReadScope,
    ]);
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopesForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toEqual([
      AuthRelayReadScope,
    ]);
    expect(requiredScopesForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toEqual([
      AuthRelayWriteScope,
    ]);
  });

  it("separates scheduled automation observation from mutation", () => {
    expect(requiredScopesForRpcMethod(SCHEDULED_AUTOMATION_WS_METHODS.dispatchCommand)).toEqual([
      AuthOrchestrationOperateScope,
      AuthOrchestrationReadScope,
    ]);
    expect(requiredScopesForRpcMethod(SCHEDULED_AUTOMATION_WS_METHODS.list)).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(requiredScopesForRpcMethod(SCHEDULED_AUTOMATION_WS_METHODS.get)).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(requiredScopesForRpcMethod(SCHEDULED_AUTOMATION_WS_METHODS.subscribe)).toEqual([
      AuthOrchestrationReadScope,
    ]);
  });

  it.effect("blocks mutation response and error disclosure unless both scopes are present", () =>
    Effect.gen(function* () {
      const evaluated = yield* Ref.make(false);
      const sensitiveResponse = Ref.set(evaluated, true).pipe(
        Effect.as({ prompt: "sensitive automation prompt" }),
      );
      const makeAuthorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `Missing ${requiredScope}`,
          requiredScope,
        });
      const error = yield* Effect.flip(
        authorizeRpcEffectForScopes(
          SCHEDULED_AUTOMATION_WS_METHODS.dispatchCommand,
          [AuthOrchestrationOperateScope],
          sensitiveResponse,
          makeAuthorizationError,
        ),
      );
      expect(error._tag).toBe("EnvironmentAuthorizationError");
      expect(error.requiredScope).toBe(AuthOrchestrationReadScope);
      expect(yield* Ref.get(evaluated)).toBe(false);

      const response = yield* authorizeRpcEffectForScopes(
        SCHEDULED_AUTOMATION_WS_METHODS.dispatchCommand,
        [AuthOrchestrationOperateScope, AuthOrchestrationReadScope],
        sensitiveResponse,
        makeAuthorizationError,
      );
      expect(response.prompt).toBe("sensitive automation prompt");
      expect(yield* Ref.get(evaluated)).toBe(true);
    }),
  );

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopesForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
