import Constants from "expo-constants";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

/**
 * The T3 Connect relay. Read from `extra.relay.url` in app.config.ts or
 * EXPO_PUBLIC_T3CODE_RELAY_URL. Without one, relay requests go to an unroutable host and
 * fail, which leaves direct pairing untouched.
 */
export function configuredRelayUrl(): string {
  const extra = Constants.expoConfig?.extra as { relay?: { url?: unknown } } | undefined;
  const raw = extra?.relay?.url ?? process.env.EXPO_PUBLIC_T3CODE_RELAY_URL;
  const normalized = typeof raw === "string" ? normalizeSecureRelayUrl(raw) : null;
  return normalized ?? "http://relay.invalid";
}
