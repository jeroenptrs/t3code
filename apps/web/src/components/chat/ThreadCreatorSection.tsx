import { describeThreadCreator } from "@t3tools/client-runtime/portal-user";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useThreadShell } from "../../state/entities";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** Which portal user started the thread, when the server recorded one. */
export function ThreadCreatorSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const label = describeThreadCreator(shell?.source.createdByUser);
  if (label === null) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-creator-heading"
      title="Started by"
      showHeading={false}
    >
      <p className="px-1.5 text-xs text-muted-foreground">{label}</p>
    </ThreadDetailsSection>
  );
}
