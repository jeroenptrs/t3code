import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, FactoryId, FactorySummary } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { attachSidebarTree } from "../../lib/sidebarTree";
import { factoriesEnvironment, type FactoryEnvironment } from "../../state/factories";
import type { SidebarSection, SidebarSections } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  factoryListedThreads,
  SETTLED_SHELF_INITIAL_COUNT,
  SETTLED_SHELF_PAGE_COUNT,
  settledShelfRows,
} from "./factories.logic";
import { FactoryScheduledTaskLinks } from "./FactoryScheduledTaskLinks";
import { NewFactoryDialog } from "./NewFactoryDialog";
import { NewWorkItemDialogHost, openNewWorkItemDialog } from "./NewWorkItemDialog";
import { SidebarFactoryRow, sidebarFactoryRowId } from "./SidebarFactoryRow";

type Shelf = "working" | "snoozed" | "settled";

const SHELVES: ReadonlyArray<Shelf> = ["working", "snoozed", "settled"];

/** The Factories tab: each environment's factories, and their runs once expanded. */
export function SidebarFactoriesList(props: {
  readonly environments: ReadonlyArray<FactoryEnvironment>;
  readonly ownedThreads: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly delegatedUnderParent: ReadonlySet<string>;
  /** Home's sections and order for a factory's threads. */
  readonly sectionsOf: (
    threads: readonly EnvironmentThreadShell[],
  ) => SidebarSections<EnvironmentThreadShell>;
  /** The open thread's row, which stays visible in a collapsed shelf as it does in Home. */
  readonly routeRowThreadKey: string | null;
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly renderThread: (
    thread: EnvironmentThreadShell,
    section: SidebarSection,
    parentRow: string,
  ) => ReactNode;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Working starts open and the other shelves closed; a key here flips its shelf.
  const [flippedShelves, setFlippedShelves] = useState<ReadonlySet<string>>(() => new Set());
  // How many settled runs each factory shows, after "show more" was pressed.
  const [settledLimits, setSettledLimits] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [creating, setCreating] = useState(false);
  const [addingTo, setAddingTo] = useState<{
    readonly environmentId: EnvironmentId;
    readonly factoryId: FactoryId;
  } | null>(null);
  const params = useParams({ strict: false });
  const activeFactoryId = params.factoryId ?? null;
  const groups = props.environments.flatMap(({ environmentId, factories }) =>
    factories === null || factories.length === 0
      ? []
      : [
          {
            environmentId,
            factories: factories.toSorted((left, right) => left.name.localeCompare(right.name)),
          },
        ],
  );
  const canCreate = props.environments.some(
    ({ factories, canManage }) => factories !== null && canManage,
  );
  const toggleIn =
    (setter: typeof setExpanded) =>
    (key: string): void =>
      setter((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      });
  const toggle = toggleIn(setExpanded);
  const toggleShelf = toggleIn(setFlippedShelves);
  const addWorkItem = (environmentId: EnvironmentId, factoryId: FactoryId, key: string) => {
    setExpanded((current) => new Set(current).add(key));
    setAddingTo({ environmentId, factoryId });
    openNewWorkItemDialog(environmentId, factoryId);
  };

  return (
    <div ref={attachSidebarTree} className="flex flex-col gap-2">
      {canCreate ? (
        <Button variant="outline" size="xs" onClick={() => setCreating(true)}>
          <PlusIcon />
          <T>New factory</T>
        </Button>
      ) : null}
      {creating ? (
        <NewFactoryDialog
          environments={props.environments}
          environmentLabelById={props.environmentLabelById}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {/* The factory page mounts its own host for the factory it shows. */}
      {addingTo !== null &&
      !(
        addingTo.factoryId === activeFactoryId && addingTo.environmentId === params.environmentId
      ) ? (
        <NewWorkItemDialogHost
          environmentId={addingTo.environmentId}
          factoryId={addingTo.factoryId}
        />
      ) : null}
      {groups.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
          {canCreate
            ? gt(
                "No factories yet. Create one to run a project's work items through its own roles.",
              )
            : gt("No factories yet")}
        </p>
      ) : null}
      {groups.map(({ environmentId, factories }) => (
        <section key={environmentId} className="flex flex-col gap-px">
          {groups.length > 1 ? (
            <h3 className="truncate px-(--sidebar-row-content-inset) pt-1 pb-0.5 text-xs font-medium text-sidebar-muted-foreground">
              {props.environmentLabelById.get(environmentId) ?? environmentId}
            </h3>
          ) : null}
          <ul role="presentation" className="flex flex-col gap-px">
            {factories.map((factory) => {
              const key = `${environmentId}\n${factory.id}`;
              const rowId = sidebarFactoryRowId(environmentId, factory.id);
              const isExpanded = expanded.has(key);
              return (
                <SidebarFactoryRow
                  key={key}
                  environmentId={environmentId}
                  factory={factory}
                  projectTitle={
                    props.projectByKey.get(`${environmentId}:${factory.projectId}`)?.title ?? null
                  }
                  active={activeFactoryId === factory.id}
                  expanded={isExpanded}
                  onToggle={() => toggle(key)}
                  action={
                    <NewWorkItemButton
                      environmentId={environmentId}
                      factory={factory}
                      rowId={rowId}
                      onClick={() => addWorkItem(environmentId, factory.id, key)}
                    />
                  }
                >
                  {isExpanded ? (
                    <FactoryThreads
                      environmentId={environmentId}
                      factory={factory}
                      rowId={rowId}
                      isShelfExpanded={(shelf) =>
                        (shelf === "working") !== flippedShelves.has(`${key}\n${shelf}`)
                      }
                      onToggleShelf={(shelf) => toggleShelf(`${key}\n${shelf}`)}
                      settledLimit={settledLimits.get(key) ?? SETTLED_SHELF_INITIAL_COUNT}
                      onShowMoreSettled={() =>
                        setSettledLimits((current) =>
                          new Map(current).set(
                            key,
                            (current.get(key) ?? SETTLED_SHELF_INITIAL_COUNT) +
                              SETTLED_SHELF_PAGE_COUNT,
                          ),
                        )
                      }
                      ownedThreads={props.ownedThreads}
                      delegatedUnderParent={props.delegatedUnderParent}
                      sectionsOf={props.sectionsOf}
                      routeRowThreadKey={props.routeRowThreadKey}
                      renderThread={props.renderThread}
                    />
                  ) : null}
                </SidebarFactoryRow>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A factory's runs in Home's sections, then its scheduled tasks. */
function FactoryThreads(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: FactorySummary;
  readonly rowId: string;
  readonly isShelfExpanded: (shelf: Shelf) => boolean;
  readonly onToggleShelf: (shelf: Shelf) => void;
  /** The settled runs shown before "show more", as Home pages its Settled shelf. */
  readonly settledLimit: number;
  readonly onShowMoreSettled: () => void;
  readonly ownedThreads: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly sectionsOf: (
    threads: readonly EnvironmentThreadShell[],
  ) => SidebarSections<EnvironmentThreadShell>;
  readonly routeRowThreadKey: string | null;
  readonly renderThread: (
    thread: EnvironmentThreadShell,
    section: SidebarSection,
    parentRow: string,
  ) => ReactNode;
}) {
  const gt = useGT();
  const threads = factoryListedThreads(
    props.environmentId,
    props.factory,
    props.ownedThreads,
    props.delegatedUnderParent,
  );
  const sections = props.sectionsOf(threads);
  const shelfLabel: Record<Shelf, string> = {
    working: gt("Working", { $context: "sidebar section" }),
    snoozed: gt("Snoozed", { $context: "sidebar section" }),
    settled: gt("Settled", { $context: "sidebar section" }),
  };
  return (
    <>
      {sections.pinned.map((thread) => props.renderThread(thread, "pinned", props.rowId))}
      {sections.active.map((thread) => props.renderThread(thread, "active", props.rowId))}
      {SHELVES.map((shelf) => {
        const shelfThreads = sections[shelf];
        if (shelfThreads.length === 0) return null;
        const shelfRow = `${props.rowId}:shelf:${shelf}`;
        const shelfExpanded = props.isShelfExpanded(shelf);
        const paged =
          shelf === "settled"
            ? settledShelfRows(shelfThreads, props.settledLimit, props.routeRowThreadKey)
            : { shown: shelfThreads, hidden: 0 };
        const shown = shelfExpanded
          ? paged.shown
          : shelfThreads.filter(
              (thread) =>
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                props.routeRowThreadKey,
            );
        return (
          <Fragment key={shelf}>
            <li className="list-none">
              <CollapsibleSectionHeader
                data-sidebar-row={shelfRow}
                data-sidebar-parent={props.rowId}
                expanded={shelfExpanded}
                onClick={() => props.onToggleShelf(shelf)}
                accessory={<span className="font-normal tabular-nums">{shelfThreads.length}</span>}
              >
                {shelfLabel[shelf]}
              </CollapsibleSectionHeader>
            </li>
            {shown.map((thread) => props.renderThread(thread, shelf, shelfRow))}
            {shelfExpanded && paged.hidden > 0 ? (
              <li className="list-none">
                <button
                  type="button"
                  data-sidebar-row={`${shelfRow}:more`}
                  data-sidebar-parent={shelfRow}
                  onClick={props.onShowMoreSettled}
                  className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  {/* Plus means "add", so revealing more uses a chevron, as in Home. */}
                  <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
                  {gt("{count, plural, one {Show {count} more} other {Show {count} more}}", {
                    count: Math.min(paged.hidden, SETTLED_SHELF_PAGE_COUNT),
                  })}
                </button>
              </li>
            ) : null}
          </Fragment>
        );
      })}
      <FactoryScheduledTaskLinks
        environmentId={props.environmentId}
        parentRow={props.rowId}
        scheduledTaskIds={props.factory.scheduledTaskIds}
      />
      {threads.length === 0 && props.factory.scheduledTaskIds.length === 0 ? (
        <li className="list-none px-(--sidebar-row-content-inset) py-1.5 text-xs text-sidebar-muted-foreground">
          <T>No runs or triggers yet</T>
        </li>
      ) : null}
    </>
  );
}

/** Starts a run: a manual work item for this factory, for people who may create one. */
function NewWorkItemButton(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: FactorySummary;
  readonly rowId: string;
  readonly onClick: () => void;
}) {
  const gt = useGT();
  const canCreate = useAtomValue(
    factoriesEnvironment.createWorkItem.permissionAtom(props.environmentId),
  );
  if (!canCreate) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-sidebar-action-for={props.rowId}
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("New work item in {factory}", { factory: props.factory.name })}
            onClick={props.onClick}
          />
        }
      >
        <PlusIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup>
        <T>
          New work item in <Var>{props.factory.name}</Var>
        </T>
      </TooltipPopup>
    </Tooltip>
  );
}
