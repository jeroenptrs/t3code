import { useAtomValue } from "@effect/atom-react";
import {
  FactoryRoleName,
  WorkItemOutcome,
  WorkItemStage,
  type EnvironmentId,
  type Factory,
  type ThreadId,
  type WorkItemSummary,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { factoriesEnvironment } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { NewWorkItemDialogHost, openNewWorkItemDialog } from "./NewWorkItemDialog";
import { WorkItemGateAnswer } from "./WorkItemGateAnswer";
import {
  FACTORY_ROLE_LABELS,
  WORK_ITEM_OUTCOME_LABELS,
  WORK_ITEM_STAGE_LABELS,
  workItemActorLabel,
  workItemListInput,
  workItemSourceLabel,
  workItemStageBadgeVariant,
  workItemThreads,
  type WorkItemSearch,
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

function WorkItemStageBadge(props: { readonly stage: WorkItemSummary["stage"] }) {
  return (
    <Badge variant={workItemStageBadgeVariant(props.stage)}>
      {WORK_ITEM_STAGE_LABELS[props.stage]}
    </Badge>
  );
}

function Timestamp(props: { readonly value: string }) {
  return (
    <time dateTime={props.value} className="text-muted-foreground">
      <RelativeTime timestamp={props.value} />
    </time>
  );
}

function ThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
}) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId: props.threadId }}
      className="hover:underline"
    >
      {props.label}
    </Link>
  );
}

const STAGE_OPTIONS = WorkItemStage.literals.map(
  (stage) => [stage, WORK_ITEM_STAGE_LABELS[stage]] as const,
);
const ROLE_OPTIONS = FactoryRoleName.literals.map(
  (role) => [role, FACTORY_ROLE_LABELS[role]] as const,
);
const OUTCOME_OPTIONS = WorkItemOutcome.literals.map(
  (outcome) => [outcome, WORK_ITEM_OUTCOME_LABELS[outcome]] as const,
);

/** The factory's work items, newest first, filtered on the server by what the URL holds. */
export function FactoryWorkItems(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly search: WorkItemSearch;
  readonly onSearchChange: (search: WorkItemSearch) => void;
}) {
  const { environmentId, search } = props;
  const query = useEnvironmentQuery(
    factoriesEnvironment.workItems({
      environmentId,
      input: workItemListInput(props.factory.id, search),
    }),
  );
  const canCreate = useAtomValue(factoriesEnvironment.createWorkItem.permissionAtom(environmentId));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const items = query.data?.workItems ?? null;
  const filtered =
    search.stage !== undefined || search.role !== undefined || search.outcome !== undefined;
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="factory-work-items">
      <div className="flex items-center gap-2">
        <h2 id="factory-work-items" className="flex-1 font-medium">
          Work items
        </h2>
        {canCreate ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => openNewWorkItemDialog(environmentId, props.factory.id)}
          >
            <PlusIcon />
            New work item
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Refresh work items"
          onClick={() => factoriesEnvironment.refresh(appAtomRegistry, environmentId)}
        >
          <RefreshIcon refreshing={query.isPending} />
        </Button>
      </div>
      <NewWorkItemDialogHost environmentId={environmentId} factoryId={props.factory.id} />
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Stage"
          allLabel="Any stage"
          value={search.stage}
          options={STAGE_OPTIONS}
          onChange={(stage) => props.onSearchChange({ ...search, stage })}
        />
        <FilterSelect
          label="Role"
          allLabel="Any role"
          value={search.role}
          options={ROLE_OPTIONS}
          onChange={(role) => props.onSearchChange({ ...search, role })}
        />
        <FilterSelect
          label="Outcome"
          allLabel="Any outcome"
          value={search.outcome}
          options={OUTCOME_OPTIONS}
          onChange={(outcome) => props.onSearchChange({ ...search, outcome })}
        />
      </div>
      {items === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          {query.error ?? "Loading work items…"}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filtered ? "No work items match these filters" : "No work items yet"}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Threads</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const open = expanded.has(item.id);
              return (
                <Fragment key={item.id}>
                  <TableRow>
                    <TableCell>
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => toggle(item.id)}
                        className="flex max-w-80 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <ChevronDownIcon
                          aria-hidden
                          className={cn(
                            "size-3 shrink-0 text-muted-foreground transition-transform",
                            !open && "-rotate-90",
                          )}
                        />
                        <span className="truncate font-medium">{item.title}</span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <WorkItemStageBadge stage={item.stage} />
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">
                        {workItemSourceLabel(item.source)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex gap-2">
                        {workItemThreads(item).map((thread) => (
                          <ThreadLink
                            key={thread.threadId}
                            environmentId={environmentId}
                            threadId={thread.threadId}
                            label={
                              thread.role === null ? "Thread" : FACTORY_ROLE_LABELS[thread.role]
                            }
                          />
                        ))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Timestamp value={item.createdAt} />
                    </TableCell>
                    <TableCell>
                      <Timestamp value={item.updatedAt} />
                    </TableCell>
                  </TableRow>
                  {open ? (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <WorkItemDetails environmentId={environmentId} item={item} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** The request, the gate question while one waits, and every stage change. Mounted when open. */
function WorkItemDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkItemSummary;
}) {
  const { item } = props;
  const query = useEnvironmentQuery(
    factoriesEnvironment.workItem({
      environmentId: props.environmentId,
      input: { workItemId: item.id },
    }),
  );
  const transitions = query.data?.transitions ?? null;
  return (
    <div className="flex flex-col gap-3 py-1 whitespace-normal">
      <p className="max-h-40 overflow-y-auto text-sm whitespace-pre-wrap">{item.source.text}</p>
      {item.gate.state === "waiting" ? (
        <WorkItemGateAnswer
          environmentId={props.environmentId}
          workItemId={item.id}
          question={item.gate.question}
        />
      ) : null}
      {transitions === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          {query.error ?? "Loading stage changes…"}
        </p>
      ) : transitions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No stage changes yet</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {transitions.map((transition) => (
            <li key={transition.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <Timestamp value={transition.at} />
              <span>
                {WORK_ITEM_STAGE_LABELS[transition.from]} to {WORK_ITEM_STAGE_LABELS[transition.to]}
              </span>
              <span className="text-muted-foreground">
                by {workItemActorLabel(transition.actor)}
              </span>
              {transition.note === null || transition.note === "" ? null : (
                <span className="basis-full whitespace-pre-wrap text-muted-foreground">
                  {transition.note}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Items a gate holds for a person, above everything else on the page. Hidden when there are none. */
export function FactoryNeedsYou(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
}) {
  const items =
    useEnvironmentQuery(
      factoriesEnvironment.workItems({
        environmentId: props.environmentId,
        input: workItemListInput(props.factory.id, { stage: "waiting" }),
      }),
    ).data?.workItems ?? [];
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="factory-needs-you">
      <h2 id="factory-needs-you" className="font-medium">
        Needs you
      </h2>
      <ul className="flex flex-col gap-3">
        {items.map((item) =>
          item.gate.state === "waiting" ? (
            <li key={item.id} className="flex flex-col gap-2 rounded-lg border p-3">
              <p className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                <span className="text-xs">
                  <Timestamp value={item.gate.askedAt} />
                </span>
              </p>
              <WorkItemGateAnswer
                environmentId={props.environmentId}
                workItemId={item.id}
                question={item.gate.question}
              />
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}
