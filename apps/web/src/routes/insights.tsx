import { createFileRoute, redirect } from "@tanstack/react-router";

import { parseInsightsSearch } from "../components/insights/insights.logic";
import { InsightsPage } from "../components/insights/InsightsPage";

export const Route = createFileRoute("/insights")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  validateSearch: parseInsightsSearch,
  component: InsightsPage,
});
