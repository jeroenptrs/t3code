import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { FACTORY_FOREMAN_THREAD_ID_PREFIX, type EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { attachSidebarTree } from "../../lib/sidebarTree";
import type { FactoryEnvironment } from "../../state/factories";
import { sortThreadsForSidebar } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { FactoryScheduledTaskLinks } from "./FactoryScheduledTaskLinks";
import { NewFactoryDialog } from "./NewFactoryDialog";
import { SidebarFactoryRow, sidebarFactoryRowId } from "./SidebarFactoryRow";

/** The Factories tab: each environment's factories, and what each owns once expanded. */
export function SidebarFactoriesList(props: {
  readonly environments: ReadonlyArray<FactoryEnvironment>;
  readonly ownedThreads: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly renderThread: (thread: EnvironmentThreadShell, parentRow: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const activeFactoryId = useParams({ strict: false }).factoryId ?? null;
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
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div ref={attachSidebarTree} className="flex flex-col gap-2">
      {canCreate ? (
        <Button variant="outline" size="xs" onClick={() => setCreating(true)}>
          <PlusIcon />
          New factory
        </Button>
      ) : null}
      {creating ? (
        <NewFactoryDialog
          environments={props.environments}
          environmentLabelById={props.environmentLabelById}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {groups.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
          {canCreate
            ? "No factories yet. A factory gives a project its own foreman, implement, and review roles."
            : "No factories yet"}
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
              const threads = sortThreadsForSidebar(
                factory.threadIds.flatMap((threadId) => {
                  const thread = props.ownedThreads.get(
                    scopedThreadKey(scopeThreadRef(environmentId, threadId)),
                  );
                  return thread === undefined || thread.archivedAt !== null ? [] : [thread];
                }),
              );
              const isForeman = (thread: EnvironmentThreadShell) =>
                thread.id.startsWith(FACTORY_FOREMAN_THREAD_ID_PREFIX);
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
                >
                  {isExpanded ? (
                    <>
                      {threads.filter(isForeman).map((thread) => (
                        <Fragment key={thread.id}>
                          <li className="list-none px-(--sidebar-row-content-inset) pt-1 text-xs font-medium text-sidebar-muted-foreground">
                            Foreman
                          </li>
                          {props.renderThread(thread, rowId)}
                        </Fragment>
                      ))}
                      {threads
                        .filter((thread) => !isForeman(thread))
                        .map((thread) => props.renderThread(thread, rowId))}
                      <FactoryScheduledTaskLinks
                        environmentId={environmentId}
                        parentRow={rowId}
                        scheduledTaskIds={factory.scheduledTaskIds}
                      />
                      {threads.length === 0 && factory.scheduledTaskIds.length === 0 ? (
                        <li className="list-none px-(--sidebar-row-content-inset) py-1.5 text-xs text-sidebar-muted-foreground">
                          Owns no threads or scheduled tasks yet
                        </li>
                      ) : null}
                    </>
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
