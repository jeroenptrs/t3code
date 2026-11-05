import { Badge } from "../ui/badge";

/** Failed runs plus open questions; nothing while there are none. */
export function FactoryAttentionBadge({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <Badge variant="warning" size="sm" title="Failed runs and questions waiting on you">
      {count}
      <span className="sr-only"> need attention</span>
    </Badge>
  );
}
