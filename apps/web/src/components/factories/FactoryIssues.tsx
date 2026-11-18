import type { FactoryIssue } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

const issueKey = (issue: FactoryIssue) =>
  `${issue.code}:${issue.role}:${issue.field}:${issue.message}`;

/** The problems the read found in one file, where that file is edited. */
export function FactoryIssuesList({ issues }: { readonly issues: ReadonlyArray<FactoryIssue> }) {
  const gt = useGT();
  if (issues.length === 0) return null;
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>
        {gt("{count, plural, =1 {A problem in this file} other {{count} problems in this file}}", {
          count: issues.length,
        })}
      </AlertTitle>
      <AlertDescription>
        <ul className="list-disc ps-4">
          {issues.map((issue) => (
            <li key={issueKey(issue)}>{issue.message}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** The issues for one field, beside it. */
export function FactoryFieldIssues({ issues }: { readonly issues: ReadonlyArray<FactoryIssue> }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-destructive-foreground" role="alert">
      {issues.map((issue) => (
        <li key={issueKey(issue)}>{issue.message}</li>
      ))}
    </ul>
  );
}
