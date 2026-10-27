import { createFileRoute } from "@tanstack/react-router";

import { InsightsOverviewView } from "../components/insights/InsightsViews";

export const Route = createFileRoute("/insights/")({
  component: InsightsOverviewView,
});
