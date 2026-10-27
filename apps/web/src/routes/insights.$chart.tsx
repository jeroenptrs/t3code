import { createFileRoute } from "@tanstack/react-router";

import { InsightsChartView } from "../components/insights/InsightsViews";

export const Route = createFileRoute("/insights/$chart")({
  component: InsightsChartView,
});
