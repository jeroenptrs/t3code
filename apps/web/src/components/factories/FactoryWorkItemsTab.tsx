import {
  canDropWorkItem,
  implementationLabel,
  isDismissedFailure,
  latestImplementation,
  latestReview,
  runningRoles,
  runningRolesLabel,
  WORK_ITEM_OUTCOME_LABELS,
  WORK_ITEM_STAGES,
  workItemActorLabel,
  workItemFailureMessage,
  workItemStageLabel,
} from "@t3tools/client-runtime/factories";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  WorkItemOutcome,
  type EnvironmentId,
  type WorkItemId,
  type WorkItemSummary,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { ArrowUpRightIcon, ListTodoIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { factoriesEnvironment } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { toastManager } from "../ui/toast";
import { openNewWorkItemDialog } from "./NewWorkItemDialog";
import { FACTORY_ROUTE, type FactoryPageSearch } from "./FactoryPage.logic";
import type { FactoryTabProps } from "./FactoryPage";
import { FactoryConfirmDialog, FactoryLoadError } from "./FactoryPageParts";
import { WorkItemGateAnswer } from "./WorkItemGateAnswer";
import {
  isWorkItemSearchFiltered,
  workItemListInput,
  workItemSourceLabel,
  workItemStageBadgeVariant,
} from "./workItems.logic";

const ALL = "all";

function FilterSelect<Value extends string>(props: {
  readonly label: string;
  readonly allLabel: string;
  readonly value: Value | undefined;
  readonly options: ReadonlyArray<readonly [Value, string]>;
  readonly onChange: (value: Value | undefined) => void;
}) {
  const items = [
    { value: ALL, label: props.allLabel },
    ...props.options.map(([value, label]) => ({ value, label })),
  ];
  return (
    <Select
      value={props.value ?? ALL}
      items={items}
      onValueChange={(value) => {
        if (value === null) return;
        props.onChange(value === ALL ? undefined : (value as Value));
      }}
    >
      <SelectTrigger size="xs" className="w-36" aria-label={props.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function WorkItemStageBadge(props: { readonly item: WorkItemSummary }) {
  const gt = useGT();
  const messages = useMessages();
  const dismissed = isDismissedFailure(props.item);
  return (
    <span className="flex items-center gap-1.5">
      <Badge variant={workItemStageBadgeVariant(props.item.stage, dismissed)}>
        {workItemStageLabel(props.item.stage, messages)}
      </Badge>
      {dismissed ? (
        <span className="text-xs text-muted-foreground">
          {gt("Dismissed", { $context: "a failed work item a person no longer needs to act on" })}
        </span>
      ) : null}
    </span>
  );
}

/** The roles a working item has a child running as; only working items read the shells. */
function WorkItemRunningRoles(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkItemSummary;
}) {
  if (props.item.stage !== "working" || props.item.threads.length === 0) return null;
  return <RunningRolesLabel environmentId={props.environmentId} item={props.item} />;
}

function RunningRolesLabel(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkItemSummary;
}) {
  const messages = useMessages();
  // A string, so a shell tick that changes no running role renders nothing.
  const label = useAtomValue(environmentThreadShells.threadShellsAtom, (shells) =>
    runningRolesLabel(runningRoles(props.item, props.environmentId, shells), messages),
  );
  if (label === "") return null;
  return <span className="truncate text-xs text-muted-foreground">{label}</span>;
}

function WorkItemsSkeleton() {
  const rows = [0, 1, 2, 3];
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <div className="flex items-center gap-2">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-6 w-36" />
        <Skeleton className="ms-auto h-6 w-32" />
      </div>
      <div className="flex flex-col divide-y">
        {rows.map((row) => (
          <div key={row} className="flex items-center gap-4 py-2.5">
            <Skeleton className="h-3.5 w-64" />
            <Skeleton className="h-4 w-16" shape="pill" />
            <Skeleton className="ms-auto h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The factory's work items, newest first, filtered on the server by what the URL holds. */
export function FactoryWorkItemsTab(props: FactoryTabProps) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, factory, search } = props;
  const navigate = useNavigate({ from: FACTORY_ROUTE });
  const query = useEnvironmentQuery(
    factoriesEnvironment.workItems({
      environmentId,
      input: workItemListInput(factory.id, search),
    }),
  );
  const canCreate = useAtomValue(factoriesEnvironment.createWorkItem.permissionAtom(environmentId));
  const items = query.data?.workItems ?? null;
  const filtered = isWorkItemSearchFiltered(search);
  const setSearch = (next: Partial<FactoryPageSearch>) =>
    void navigate({ search: (current) => ({ ...current, ...next }), replace: true });
  const stageOptions = WORK_ITEM_STAGES.map(
    (stage) => [stage, workItemStageLabel(stage, messages)] as const,
  );
  const outcomeOptions = WorkItemOutcome.literals.map(
    (outcome) => [outcome, messages(WORK_ITEM_OUTCOME_LABELS[outcome])] as const,
  );
  const createButton = canCreate ? (
    <Button size="xs" onClick={() => openNewWorkItemDialog(environmentId, factory.id)}>
      <PlusIcon />
      <T>New work item</T>
    </Button>
  ) : null;

  if (items === null) {
    return query.error === null ? (
      <WorkItemsSkeleton />
    ) : (
      <FactoryLoadError
        title={gt("Could not load work items")}
        message={query.error}
        onRetry={() => factoriesEnvironment.refresh(appAtomRegistry, environmentId)}
      />
    );
  }

  if (items.length === 0 && !filtered) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <ListTodoIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>
            <T>No work items yet</T>
          </EmptyTitle>
          <EmptyDescription>
            <T>Send the factory a request, or attach a trigger that sends them.</T>
          </EmptyDescription>
        </EmptyHeader>
        {createButton}
      </Empty>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label={gt("Stage", { $context: "work item filter" })}
          allLabel={gt("Any stage")}
          value={search.stage}
          options={stageOptions}
          onChange={(stage) => setSearch({ stage })}
        />
        <FilterSelect
          label={gt("Outcome", { $context: "work item filter" })}
          allLabel={gt("Any outcome")}
          value={search.outcome}
          options={outcomeOptions}
          onChange={(outcome) => setSearch({ outcome })}
        />
        <div className="ms-auto flex items-center gap-2">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Refresh work items")}
            onClick={() => factoriesEnvironment.refresh(appAtomRegistry, environmentId)}
          >
            <RefreshIcon refreshing={query.isPending} />
          </Button>
          {createButton}
        </div>
      </div>
      {items.length === 0 ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>
              <T>No work items match these filters</T>
            </EmptyTitle>
          </EmptyHeader>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSearch({ stage: undefined, outcome: undefined })}
          >
            <T>Clear filters</T>
          </Button>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{gt("Title", { $context: "work item column" })}</TableHead>
              <TableHead>{gt("Stage", { $context: "work item column" })}</TableHead>
              <TableHead className="max-sm:hidden">
                {gt("Source", { $context: "work item column" })}
              </TableHead>
              <TableHead>{gt("Updated", { $context: "work item column" })}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow
                key={item.id}
                tabIndex={0}
                aria-label={item.title}
                className="cursor-pointer"
                onClick={() => setSearch({ item: item.id })}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setSearch({ item: item.id });
                }}
              >
                <TableCell>
                  <span className="block max-w-80 truncate font-medium">{item.title}</span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <WorkItemStageBadge item={item} />
                    <WorkItemRunningRoles environmentId={environmentId} item={item} />
                  </span>
                </TableCell>
                <TableCell className="max-sm:hidden">
                  <span className="block max-w-48 truncate">
                    {workItemSourceLabel(item.source, messages)}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">
                    <RelativeTime timestamp={item.updatedAt} />
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <WorkItemSheet
        environmentId={environmentId}
        workItemId={search.item ?? null}
        onClose={() => setSearch({ item: undefined })}
      />
    </section>
  );
}

function WorkItemSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly workItemId: WorkItemId | null;
  readonly onClose: () => void;
}) {
  return (
    <Sheet
      open={props.workItemId !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetPopup side="right" className="sm:max-w-lg">
        {props.workItemId === null ? null : (
          <WorkItemDetail
            key={props.workItemId}
            environmentId={props.environmentId}
            workItemId={props.workItemId}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}

/** The run thread, the gate while one waits, the item's actions, and every stage change. */
function WorkItemDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly workItemId: WorkItemId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId } = props;
  const query = useEnvironmentQuery(
    factoriesEnvironment.workItem({ environmentId, input: { workItemId: props.workItemId } }),
  );
  const item = query.data;
  if (item === null) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>
            {query.error === null ? <Skeleton className="h-6 w-56" /> : gt("Work item")}
          </SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-6 pb-6">
          {query.error === null ? (
            <>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-20 w-full" />
            </>
          ) : (
            <FactoryLoadError
              title={gt("Could not load the work item")}
              message={query.error}
              onRetry={query.refresh}
            />
          )}
        </div>
      </>
    );
  }
  return (
    <>
      <SheetHeader>
        <SheetTitle className="me-8">{item.title}</SheetTitle>
        <SheetDescription render={<div />}>
          <span className="flex items-center gap-2">
            <WorkItemStageBadge item={item} />
            <WorkItemRunningRoles environmentId={environmentId} item={item} />
          </span>
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          {item.foremanThreadId === null ? null : (
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: item.foremanThreadId }}
                />
              }
            >
              <T>Open run thread</T>
              <ArrowUpRightIcon />
            </Button>
          )}
          <WorkItemActions environmentId={environmentId} item={item} />
        </div>
        {item.stage === "waiting" && item.gate.state === "waiting" ? (
          <WorkItemGateAnswer
            environmentId={environmentId}
            workItemId={item.id}
            question={item.gate.question}
          />
        ) : null}
        <WorkItemResults item={item} />
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            <T>Request</T>
          </h3>
          <p className="max-h-48 overflow-y-auto text-sm whitespace-pre-wrap">{item.source.text}</p>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            <T>Stage history</T>
          </h3>
          {item.transitions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>No stage changes yet</T>
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {item.transitions.map((transition) => (
                <li key={transition.id} className="flex flex-col gap-0.5 text-sm">
                  <span>
                    {transition.from === transition.to
                      ? workItemStageLabel(transition.to, messages)
                      : gt("{from} to {to}", {
                          from: workItemStageLabel(transition.from, messages),
                          to: workItemStageLabel(transition.to, messages),
                        })}
                  </span>
                  <span className="flex gap-2 text-xs text-muted-foreground">
                    <span>{workItemActorLabel(transition.actor, messages)}</span>
                    <time dateTime={transition.at}>
                      <RelativeTime timestamp={transition.at} />
                    </time>
                  </span>
                  {transition.note === null || transition.note === "" ? null : (
                    <span className="text-xs whitespace-pre-wrap text-muted-foreground">
                      {transition.note}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}

/** What the children returned as data: the latest review and the latest implementation. */
function WorkItemResults(props: { readonly item: WorkItemSummary }) {
  const gt = useGT();
  const review = latestReview(props.item);
  const implementation = latestImplementation(props.item);
  if (review === null && implementation === null) return null;
  return (
    <>
      {implementation === null ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            <T>Implementation</T>
          </h3>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs">{implementationLabel(implementation)}</span>
            <Badge variant={implementation.checksPassed ? "success" : "warning"}>
              {implementation.checksPassed ? gt("Checks passed") : gt("Checks failed")}
            </Badge>
          </p>
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">
            {implementation.summary}
          </p>
        </section>
      )}
      {review === null ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <T>Review</T>
            <Badge variant={review.verdict === "approve" ? "success" : "warning"}>
              {review.verdict === "approve"
                ? gt("Approved", { $context: "a review verdict" })
                : gt("Changes requested", { $context: "a review verdict" })}
            </Badge>
          </h3>
          {review.findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>No findings</T>
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {review.findings.map((finding) => (
                <li
                  key={`${finding.file ?? ""}:${finding.line ?? ""}:${finding.summary}`}
                  className="flex flex-col gap-0.5 text-sm"
                >
                  <span className="whitespace-pre-wrap">{finding.summary}</span>
                  <span className="flex gap-2 text-xs text-muted-foreground">
                    {finding.file === undefined ? null : (
                      <span className="font-mono">
                        {finding.line === undefined
                          ? finding.file
                          : `${finding.file}:${finding.line}`}
                      </span>
                    )}
                    <span>
                      {finding.blocking
                        ? gt("Blocking", { $context: "a review finding" })
                        : gt("Not blocking", { $context: "a review finding" })}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  );
}

/** Dismiss or restore a failure, and drop an item that has not ended. */
function WorkItemActions(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkItemSummary;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, item } = props;
  const canDismiss = useAtomValue(
    factoriesEnvironment.dismissWorkItemFailure.permissionAtom(environmentId),
  );
  const canDrop = useAtomValue(factoriesEnvironment.dropWorkItem.permissionAtom(environmentId));
  const dismiss = useAtomCommand(factoriesEnvironment.dismissWorkItemFailure, {
    label: "dismiss a work item failure",
    reportFailure: false,
  });
  const drop = useAtomCommand(factoriesEnvironment.dropWorkItem, {
    label: "drop a work item",
    reportFailure: false,
  });
  const [dismissing, setDismissing] = useState(false);
  const [confirmingDrop, setConfirmingDrop] = useState(false);
  const dismissed = item.failureDismissedAt !== null;

  const toggleDismissed = async () => {
    setDismissing(true);
    const result = await dismiss({
      environmentId,
      input: { workItemId: item.id, dismissed: !dismissed },
    });
    setDismissing(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: dismissed
          ? gt("Could not restore the failure")
          : gt("Could not dismiss the failure"),
        description: workItemFailureMessage(
          squashAtomCommandFailure(result),
          gt("The failure could not be updated."),
          messages,
        ),
      });
    }
  };

  return (
    <>
      {canDismiss && item.stage === "failed" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={dismissing}
          onClick={() => void toggleDismissed()}
        >
          {dismissed ? gt("Restore failure") : gt("Dismiss failure")}
        </Button>
      ) : null}
      {canDrop && canDropWorkItem(item) ? (
        <>
          <Button size="sm" variant="destructive-outline" onClick={() => setConfirmingDrop(true)}>
            <T>Drop item</T>
          </Button>
          <FactoryConfirmDialog
            open={confirmingDrop}
            title={gt("Drop {title}?", { title: item.title })}
            description={gt(
              "The item ends as dropped and its Foreman thread is told to stop. This cannot be undone.",
            )}
            confirmLabel={gt("Drop item")}
            onClose={() => setConfirmingDrop(false)}
            onConfirm={async () => {
              const result = await drop({ environmentId, input: { workItemId: item.id } });
              if (result._tag === "Success") return null;
              return workItemFailureMessage(
                squashAtomCommandFailure(result),
                gt("The item could not be dropped."),
                messages,
              );
            }}
          />
        </>
      ) : null}
    </>
  );
}
