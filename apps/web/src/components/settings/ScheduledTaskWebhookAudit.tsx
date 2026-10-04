import { describeWebhookAudit } from "@t3tools/client-runtime/portal-user";
import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";

const rotatedOnFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Who created a webhook task and last rotated its token, when the server knows. */
export function ScheduledTaskWebhookAudit({
  endpoint,
}: {
  readonly endpoint: ScheduledTaskWebhookEndpoint;
}) {
  const lines = describeWebhookAudit(endpoint, (isoDate) =>
    rotatedOnFormatter.format(new Date(isoDate)),
  );
  if (lines.length === 0) return null;
  return (
    <div className="text-xs text-muted-foreground">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
