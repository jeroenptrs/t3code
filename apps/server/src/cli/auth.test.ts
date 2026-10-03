// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../binCli.ts";

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

// Each Console.log call is one entry, so the latest command's output is the last one.
const lastOutput = Effect.map(
  TestConsole.logLines,
  (lines) => lines.findLast((line): line is string => typeof line === "string") ?? "",
);

interface ListedUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly objectId: string;
  readonly status: string;
  readonly role: string | null;
}

describe("t3 auth user", () => {
  it.effect("provisions an administrator before first sign-in, idempotently", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-auth-user-test-"));
      const identityFlags = [
        "--tenant-id",
        "8F2C3A1E-1B2C-4D5E-8F90-123456789ABC",
        "--object-id",
        "00000000-0000-4000-8000-00000000000a",
      ];

      yield* runCli(["auth", "user", "provision-admin", ...identityFlags, "--base-dir", baseDir]);
      yield* runCli(["auth", "user", "provision-admin", ...identityFlags, "--base-dir", baseDir]);
      yield* runCli(["auth", "user", "list", "--base-dir", baseDir, "--json"]);

      // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
      const users = JSON.parse(yield* lastOutput) as ReadonlyArray<ListedUser>;
      assert.equal(users.length, 1);
      assert.deepInclude(users[0], {
        tenantId: "8f2c3a1e-1b2c-4d5e-8f90-123456789abc",
        objectId: "00000000-0000-4000-8000-00000000000a",
        status: "active",
        role: "administrator",
      });
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
    ),
  );

  it.effect("warns when the tenant is not the configured Entra tenant", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-auth-user-test-"));
      const provision = (tenantId: string) =>
        runCli([
          "auth",
          "user",
          "provision-admin",
          "--tenant-id",
          tenantId,
          "--object-id",
          "00000000-0000-4000-8000-00000000000a",
          "--base-dir",
          baseDir,
        ]);

      yield* provision("8F2C3A1E-1B2C-4D5E-8F90-123456789ABC");
      expect(yield* TestConsole.errorLines).toEqual([]);

      yield* provision("0a0b0c0d-1b2c-4d5e-8f90-123456789abc");
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "is not the configured Entra tenant",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NetService.layer,
          TestConsole.layer,
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_ENTRA_TENANT_ID: "8f2c3a1e-1b2c-4d5e-8f90-123456789abc",
                T3CODE_ENTRA_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
                T3CODE_ENTRA_CLIENT_SECRET: "secret",
                T3CODE_PUBLIC_URL: "https://t3.example.com",
              },
            }),
          ),
        ),
      ),
    ),
  );
});
