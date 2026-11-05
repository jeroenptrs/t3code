import type { FactoryIssue } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

const ROLE_LABEL = { foreman: "Foreman", implement: "Implement", review: "Review" } as const;

const issueKey = (issue: FactoryIssue) =>
  `${issue.code}:${issue.role}:${issue.field}:${issue.message}`;

/** Every problem the read found in the definition files. */
export function FactoryIssuesList({ issues }: { readonly issues: ReadonlyArray<FactoryIssue> }) {
  if (issues.length === 0) return null;
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>
        {issues.length === 1
          ? "1 problem in the definition"
          : `${issues.length} problems in the definition`}
      </AlertTitle>
      <AlertDescription>
        <ul className="list-disc ps-4">
          {issues.map((issue) => (
            <li key={issueKey(issue)}>
              {issue.role === null ? null : `${ROLE_LABEL[issue.role]}: `}
              {issue.message}
            </li>
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
