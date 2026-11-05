/**
 * Runs one Home operation in this environment with the user's reach. Nothing
 * here deletes data. Home's server calls it in process, other environments
 * over `fleet.invoke`. The layer is in `FleetServiceLayer.ts` because it
 * imports the MCP service, and MCP tools depend on this tag.
 */
import {
  type FleetInvokeInput,
  type ProjectId,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import type * as ProjectService from "../project/ProjectService.ts";

export class FleetService extends Context.Service<
  FleetService,
  {
    /** Runs one operation and returns its result, typed by `FleetResults[op]`. */
    readonly execute: (input: FleetInvokeInput) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/home/FleetService") {}

/**
 * Fails when a launch would run in Home's folder, as its project or an
 * existing worktree. That folder's instructions make any agent there act as
 * Home. Every Home launch path calls this.
 */
export const refuseHomeFolder = Effect.fn("FleetService.refuseHomeFolder")(function* (
  services: {
    readonly projects: ProjectService.ProjectService["Service"];
    readonly folders: ManagedProjectFolders.ManagedProjectFolders["Service"];
  },
  input: {
    readonly projectId: ProjectId;
    readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  },
) {
  const project = yield* services.projects.getById(input.projectId).pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: error instanceof Error ? error.message : "The project could not be read.",
        }),
    ),
  );
  const roots = [
    ...(Option.isSome(project) ? [project.value.workspaceRoot] : []),
    ...(input.workspaceStrategy?.type === "existing_worktree"
      ? [input.workspaceStrategy.worktreePath]
      : []),
  ];
  for (const root of roots) {
    if (yield* services.folders.isInHomeFolder(root)) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Threads never launch in Home's folder.",
      });
    }
  }
});
