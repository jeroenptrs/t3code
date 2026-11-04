import { Link } from "@tanstack/react-router";
import { ChartLineIcon } from "lucide-react";

import { useCanReadInsights } from "../../state/insights";
import { Button } from "../ui/button";

/** Fork-only. Insights is reached from the Issues and Pull requests headers, administrators only. */
export function InsightsLink() {
  const canReadInsights = useCanReadInsights();
  if (!canReadInsights) return null;
  return (
    <Button size="compact" variant="ghost-muted" render={<Link to="/insights" />}>
      <ChartLineIcon aria-hidden />
      Insights
    </Button>
  );
}
