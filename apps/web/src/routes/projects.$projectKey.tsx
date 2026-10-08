import { createFileRoute, redirect } from "@tanstack/react-router";
import { requiresPairingRedirect } from "../authGate";

export const Route = createFileRoute("/projects/$projectKey")({
  beforeLoad: async ({ context, params }) => {
    if (requiresPairingRedirect(context.authGateState)) {
      throw redirect({ to: "/pair", replace: true });
    }
    throw redirect({
      to: "/settings/projects",
      search: { project: params.projectKey, machine: undefined },
      replace: true,
    });
  },
});
