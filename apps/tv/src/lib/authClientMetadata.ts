import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import * as Device from "expo-device";

/** How the server's sessions list and the relay label this client. */
export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  const osMajorVersion = Number.parseInt(Device.osVersion?.split(".")[0] ?? "", 10);
  const deviceModel = Device.modelName?.trim();

  return {
    label: "T3 Code TV",
    deviceType: "tv",
    os: "tvOS",
    ...(Number.isFinite(osMajorVersion) && osMajorVersion > 0 ? { osMajorVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    surface: "tv",
    ...(appVersion ? { appVersion } : {}),
  };
}
