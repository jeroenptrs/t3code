// Adapts upstream pingdotgg/t3code#15975 (Home's thread-management toolkit and watch reports).
import type { HomeWatchReport } from "@t3tools/contracts";

import { HomeService } from "../../home/HomeService.ts";

export {
  FleetResults,
  isHomeLaunchedThreadId,
  type FleetActor,
  type FleetInput,
  type FleetInvokeInput,
  type FleetOperation,
  type FleetRequest,
  type FleetResult,
  type HomeWatch,
  type HomeWatchEvent,
  type HomeWatchEventKind,
  type HomeWatchReport,
} from "@t3tools/contracts";
export { FleetService } from "../../home/FleetService.ts";

// Wraps only `report`. The HomeService tag can also turn Home on and off.
export const reportToHome = (report: HomeWatchReport) =>
  HomeService.use((home) => home.report(report));
