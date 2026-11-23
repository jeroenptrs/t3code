import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { JiraIssueSummary, ScheduledTaskId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { FACTORY_ROUTE } from "./FactoryPage.logic";
import type { FactoryTabProps } from "./FactoryPage";
import {
  FactoryCardSkeleton,
  FactoryLoadError,
  FactoryRowLink,
  ROW_LINK_CLASS,
} from "./FactoryPageParts";

// A poll reads at most this many issues, so a full list may be cut short.
const POLL_ISSUE_CAP = 500;

/** The issues a Jira query trigger's last check stored, and a way to check again now. */
export function FactoryTriggerIssuesPage(
  props: FactoryTabProps & { readonly triggerId: ScheduledTaskId },
) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, factory, triggerId } = props;
  const canCheck = useAtomValue(serverEnvironment.checkTriggerNow.permissionAtom(environmentId));
  const checkNow = useAtomCommand(serverEnvironment.checkTriggerNow, {
    label: "trigger check now",
  });
  const [checking, setChecking] = useState(false);
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const task = tasks.data?.tasks.find((candidate) => candidate.id === triggerId);
  const isJiraQuery = task?.schedule.type === "jira_query";
  const issues = useEnvironmentQuery(
    isJiraQuery
      ? serverEnvironment.triggerJiraQueryIssues({ environmentId, input: { id: triggerId } })
      : null,
    messages,
  );

  const check = async () => {
    setChecking(true);
    const result = await checkNow({ environmentId, input: { id: triggerId } });
    setChecking(false);
    issues.refresh();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not check the trigger"),
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };

  const back = (
    <Button
      size="xs"
      variant="ghost-muted"
      className="self-start"
      render={
        <Link
          to={FACTORY_ROUTE}
          params={{ environmentId, factoryId: factory.id }}
          search={{ tab: "triggers" }}
        />
      }
    >
      <ArrowLeftIcon />
      {gt("Triggers", { $context: "factory page tab" })}
    </Button>
  );

  if (tasks.data === null) {
    return tasks.error === null ? (
      <FactoryCardSkeleton />
    ) : (
      <FactoryLoadError
        title={gt("Could not load triggers")}
        message={tasks.error}
        onRetry={tasks.refresh}
      />
    );
  }
  if (task === undefined || !isJiraQuery || task.target?.factoryId !== factory.id) {
    return (
      <>
        {back}
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>
              <T>This factory has no Jira query trigger here.</T>
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const result = issues.data;
  const found = result?.issues ?? [];
  const failure = task.lastRunStatus === "failed" ? task.lastRunError : null;
  return (
    <>
      {back}
      <SettingsSection
        title={task.title}
        headerAction={
          canCheck && props.canManage ? (
            <Button size="xs" variant="outline" disabled={checking} onClick={() => void check()}>
              <RefreshCwIcon />
              {checking ? <T>Checking…</T> : <T>Check now</T>}
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-1 px-3 py-3 text-sm sm:px-4">
          {result?.query ? <code className="text-xs break-all">{result.query}</code> : null}
          <span className="text-xs text-muted-foreground">
            {result?.checkedAt ? (
              <T>
                Checked <RelativeTime timestamp={result.checkedAt} />.
              </T>
            ) : (
              <T>Not checked yet.</T>
            )}{" "}
            {task.enabled ? null : <T>The trigger is off, so a check acts on nothing.</T>}
          </span>
          {failure === null ? null : (
            <p className="text-xs text-destructive-foreground" role="alert">
              {failure}
            </p>
          )}
        </div>
      </SettingsSection>
      <SettingsSection
        title={gt("{count, plural, =1 {One matching issue} other {{count} matching issues}}", {
          count: found.length,
        })}
      >
        {result === null ? (
          issues.error === null ? (
            <FactoryCardSkeleton rows={3} />
          ) : (
            <p className="px-3 py-3 text-sm text-destructive-foreground sm:px-4">{issues.error}</p>
          )
        ) : found.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>
                {result.checkedAt === null ? <T>No check has run yet</T> : <T>No issues match</T>}
              </EmptyTitle>
              <EmptyDescription>
                {result.checkedAt === null ? (
                  <T>Check now to read the issues the query finds.</T>
                ) : (
                  <T>The last check found nothing for this query.</T>
                )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {found.map((issue) => (
              <IssueRow key={`${issue.site}/${issue.key}`} issue={issue} />
            ))}
            {found.length >= POLL_ISSUE_CAP ? (
              <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
                <T>A check reads the first 500 issues, so there may be more.</T>
              </p>
            ) : null}
          </>
        )}
      </SettingsSection>
    </>
  );
}

function IssueRow({ issue }: { readonly issue: JiraIssueSummary }) {
  const facts = [
    issue.status,
    issue.assignee?.displayName ?? null,
    issue.labels.length === 0 ? null : issue.labels.join(", "),
  ].filter((fact) => fact !== null);
  return (
    <FactoryRowLink
      title={
        <>
          <span className="text-muted-foreground">{issue.key}</span> {issue.summary}
        </>
      }
      meta={
        <span className="flex flex-wrap gap-x-3">
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
          {issue.updated === null ? null : (
            <span>
              <RelativeTime timestamp={issue.updated} />
            </span>
          )}
        </span>
      }
      link={
        <a
          href={issue.url}
          target="_blank"
          rel="noopener noreferrer"
          className={ROW_LINK_CLASS}
          aria-label={`${issue.key} ${issue.summary}`}
        />
      }
    />
  );
}
