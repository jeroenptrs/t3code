import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServer } from "effect/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import {
  buildPairingUrl,
  formatHeadlessServeOutput,
  renderTerminalQrCode,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveHeadlessServeOutput,
  resolveListeningPort,
} from "./startupAccess.ts";

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionHost(undefined)).toBe("localhost");
  expect(resolveHeadlessConnectionString(undefined, 3773)).toBe("http://localhost:3773");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});

it.effect("headless startup with Entra sign-in mints and prints no pairing token", () =>
  Effect.gen(function* () {
    const output = yield* resolveHeadlessServeOutput().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            issueStartupPairingCredential: () =>
              Effect.die(new Error("startup must not mint a pairing token")),
          } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
          Layer.succeed(HttpServer.HttpServer, {
            address: { _tag: "TcpAddress", hostname: "0.0.0.0", port: 3773 },
          } as unknown as HttpServer.HttpServer["Service"]),
          Layer.effect(
            ServerConfig.ServerConfig,
            Effect.map(ServerConfig.ServerConfig, (config) => ({
              ...config,
              entraSignIn: {
                tenantId: "8f2c3a1e-1b2c-4d5e-8f90-123456789abc",
                clientId: "11111111-2222-4333-8444-555555555555",
                clientSecret: Redacted.make("secret"),
                publicUrl: new URL("https://t3.example.com"),
                callbackPath: ServerConfig.DEFAULT_ENTRA_CALLBACK_PATH,
              },
            })),
          ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-startup-" }))),
        ),
      ),
    );

    expect(output).toContain("https://t3.example.com");
    expect(output).not.toContain("Token:");
    expect(output).not.toContain("/pair");
  }).pipe(Effect.provide(NodeServices.layer)),
);
