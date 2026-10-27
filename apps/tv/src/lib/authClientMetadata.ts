import type {
  AuthClientMetadataDeviceType,
  AuthClientPresentationMetadata,
} from "@t3tools/contracts";
import * as Device from "expo-device";

/**
 * Pre-TV servers reject client_device_type "tv" at /oauth/token with a 400, so send "unknown";
 * surface "tv" still identifies the client. Switch to "tv" once servers that accept it ship.
 */
export const TV_WIRE_DEVICE_TYPE: AuthClientMetadataDeviceType = "unknown";

/** How the server's sessions list and the relay label this client. */
export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  const osMajorVersion = Number.parseInt(Device.osVersion?.split(".")[0] ?? "", 10);
  const deviceModel = Device.modelName?.trim();

  return {
    label: "T3 Code TV",
    deviceType: TV_WIRE_DEVICE_TYPE,
    os: "tvOS",
    ...(Number.isFinite(osMajorVersion) && osMajorVersion > 0 ? { osMajorVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    surface: "tv",
    ...(appVersion ? { appVersion } : {}),
  };
}
