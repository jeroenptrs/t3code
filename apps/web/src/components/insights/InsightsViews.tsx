import { Link, useParams } from "@tanstack/react-router";
import { ChartLineIcon, Maximize2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InsightsContributorTable } from "./InsightsContributorTable";
import { INSIGHTS_CHART_VIEWS, InsightsHeadlineTiles } from "./InsightsCharts";
import { INSIGHTS_CHARTS, INSIGHTS_ESTIMATE_LABEL, insightsChartByKey } from "./insights.logic";
import { useInsightsOverview } from "./InsightsPage";

function TeamTrendWarning() {
  return (
    <p className="text-xs text-muted-foreground">
      Read these numbers as a team trend. Do not rank or judge individuals by them: estimates per
      person are noisy, leave out review, planning and investigation, and reward large diffs.
    </p>
  );
}

function Reading({ text }: { readonly text: string | null }) {
  return (
    <p className="text-sm text-muted-foreground">{text ?? "Reading estimated coding output…"}</p>
  );
}

export function InsightsOverviewView() {
  const overview = useInsightsOverview();
  if (overview.data === null) return <Reading text={overview.error} />;
  const data = overview.data;
  return (
    <>
      <p className="text-xs text-muted-foreground">{INSIGHTS_ESTIMATE_LABEL}</p>
      <InsightsHeadlineTiles headline={data.headline} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {INSIGHTS_CHARTS.map((chart) => {
          const { Card } = INSIGHTS_CHART_VIEWS[chart.key];
          return (
            <section
              key={chart.key}
              aria-labelledby={`insights-chart-${chart.key}`}
              className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
            >
              <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <h2 id={`insights-chart-${chart.key}`} className="text-sm font-medium">
                    {chart.title}
                  </h2>
                  <p className="text-xs text-muted-foreground">{chart.description}</p>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Expand ${chart.title}`}
                  render={
                    <Link
                      to="/insights/$chart"
                      params={{ chart: chart.key }}
                      search={(previous) => previous}
                    />
                  }
                >
                  <Maximize2Icon />
                  Expand
                </Button>
              </div>
              <Card overview={data} />
            </section>
          );
        })}
      </div>
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Contributors</h2>
          <p className="text-xs text-muted-foreground">
            {INSIGHTS_ESTIMATE_LABEL} Throughput is pushed hours over {data.workingDays} working{" "}
            {data.workingDays === 1 ? "day" : "days"} of eight hours.
          </p>
        </div>
        {data.contributors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No included contributor has commits or merge requests in this window.
          </p>
        ) : (
          <InsightsContributorTable rows={data.contributors} />
        )}
        <TeamTrendWarning />
      </section>
    </>
  );
}

export function InsightsChartView() {
  const chart = insightsChartByKey(useParams({ from: "/insights/$chart" }).chart);
  const overview = useInsightsOverview();
  if (chart === null) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <ChartLineIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No such chart</EmptyTitle>
          <EmptyDescription>This link names a chart Insights does not have.</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" render={<Link to="/insights" search={(previous) => previous} />}>
          Back to Insights
        </Button>
      </Empty>
    );
  }
  if (overview.data === null) return <Reading text={overview.error} />;
  const { Expanded } = INSIGHTS_CHART_VIEWS[chart.key];
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm">{chart.description}</p>
        <p className="text-xs text-muted-foreground">{INSIGHTS_ESTIMATE_LABEL}</p>
      </div>
      <Expanded overview={overview.data} />
      <TeamTrendWarning />
    </section>
  );
}
