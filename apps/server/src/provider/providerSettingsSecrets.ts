import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  providerSettingsSecretKeys,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { CursorSettings } from "@t3tools/provider-cursor/settings";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import { MuseSettings } from "@t3tools/provider-muse/settings";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import { PiSettings } from "@t3tools/provider-pi/settings";

/**
 * Every built-in driver's config schema. Listed here rather than read from
 * `BUILT_IN_DRIVERS`, which would pull the drivers into serverSettings.ts and
 * close an import cycle; serverSettings.test.ts checks the two agree.
 */
export const PROVIDER_SETTINGS_SCHEMAS = [
  CodexSettings,
  ClaudeSettings,
  CursorSettings,
  GrokSettings,
  AntigravitySettings,
  MuseSettings,
  PiSettings,
  AcpRegistrySettings,
  OpenCodeSettings,
] as const;

/**
 * Secret keys across every provider config. The server redacts these keys in
 * any provider config blob, whatever its driver, so a fork driver that reuses
 * a built-in key name is covered too.
 */
export const PROVIDER_SETTINGS_SECRET_KEYS: ReadonlySet<string> = new Set(
  PROVIDER_SETTINGS_SCHEMAS.flatMap(providerSettingsSecretKeys),
);
