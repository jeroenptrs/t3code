import { createFileRoute } from "@tanstack/react-router";

import { InsightsSettings } from "../components/insights/InsightsSettings";

export const Route = createFileRoute("/settings/insights")({
  component: InsightsSettings,
});
