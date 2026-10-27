import type { InsightsHeadline, InsightsOverview } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";

import { cn } from "../../lib/utils";
import { InsightsCycleCard, InsightsCycleExpanded } from "./InsightsCycleChart";
import { InsightsJiraCard, InsightsJiraExpanded } from "./InsightsJiraChart";
import { InsightsLeadTimeCard, InsightsLeadTimeExpanded } from "./InsightsLeadTimeChart";
import { InsightsMixCard, InsightsMixExpanded } from "./InsightsMixChart";
import { InsightsReviewsCard, InsightsReviewsExpanded } from "./InsightsReviewsChart";
import { InsightsSizeCard, InsightsSizeExpanded } from "./InsightsSizeChart";
import { InsightsTrendCard, InsightsTrendExpanded } from "./InsightsTrendChart";
import { formatInsightsDays, formatInsightsShare, type InsightsChartKey } from "./insights.logic";

type ChartView = ComponentType<{ readonly overview: InsightsOverview }>;

export const INSIGHTS_CHART_VIEWS: Record<
  InsightsChartKey,
  { readonly Card: ChartView; readonly Expanded: ChartView }
> = {
  trend: { Card: InsightsTrendCard, Expanded: InsightsTrendExpanded },
  cycle: { Card: InsightsCycleCard, Expanded: InsightsCycleExpanded },
  leadTime: { Card: InsightsLeadTimeCard, Expanded: InsightsLeadTimeExpanded },
  size: { Card: InsightsSizeCard, Expanded: InsightsSizeExpanded },
  mix: { Card: InsightsMixCard, Expanded: InsightsMixExpanded },
  reviews: { Card: InsightsReviewsCard, Expanded: InsightsReviewsExpanded },
  jira: { Card: InsightsJiraCard, Expanded: InsightsJiraExpanded },
};

const TILES: ReadonlyArray<{
  readonly label: string;
  readonly chart: InsightsChartKey;
  readonly value: (headline: InsightsHeadline) => string;
}> = [
  {
    label: "Lead time to land",
    chart: "leadTime",
    value: (headline) => formatInsightsDays(headline.leadTimeMedianDays),
  },
  {
    label: "Median merge request",
    chart: "size",
    value: (headline) =>
      headline.medianMergeRequestLines === null
        ? "-"
        : `${Math.round(headline.medianMergeRequestLines)} lines`,
  },
  {
    label: "Merged without review",
    chart: "reviews",
    value: (headline) => formatInsightsShare(headline.unreviewedMergeShare),
  },
  {
    label: "Agent-assisted pushed hours",
    chart: "trend",
    value: (headline) => formatInsightsShare(headline.agentAssistedShare),
  },
  {
    label: "Abandoned merge requests",
    chart: "cycle",
    value: (headline) => formatInsightsShare(headline.abandonedShare),
  },
];

const JIRA_TILE: (typeof TILES)[number] = {
  label: "Unticketed share",
  chart: "jira",
  value: (headline) => formatInsightsShare(headline.unticketedShare),
};

export function InsightsHeadlineTiles({ overview }: { readonly overview: InsightsOverview }) {
  const tiles = overview.jira === null ? TILES : [...TILES, JIRA_TILE];
  const headline = overview.headline;
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 sm:grid-cols-3",
        tiles.length > 5 ? "lg:grid-cols-6" : "lg:grid-cols-5",
      )}
    >
      {tiles.map((tile) => (
        <Link
          key={tile.label}
          to="/insights/$chart"
          params={{ chart: tile.chart }}
          search={(previous) => previous}
          className="flex flex-col gap-1 rounded-lg border px-3 py-2.5 hover:bg-muted/50"
        >
          <span className="text-xs text-muted-foreground">{tile.label}</span>
          <span className="text-lg font-medium tabular-nums">{tile.value(headline)}</span>
        </Link>
      ))}
    </div>
  );
}
