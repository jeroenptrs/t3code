import { useAtomValue } from "@effect/atom-react";
import {
  createNeedsYouSelector,
  needsYouListInputs,
  type NeedsYouRow,
} from "@t3tools/client-runtime/factories";
import type { EnvironmentId, FactoryId, WorkItemSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { T, useGT } from "gt-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { factoriesEnvironment } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
import { RelativeTime } from "../RelativeTime";
import { SettingsSection } from "../settings/settingsLayout";
import { FactoryCanvas } from "./FactoryCanvas";
import { FACTORY_ROUTE } from "./FactoryPage.logic";
import type { FactoryTabProps } from "./FactoryPage";
import {
  FactoryCardSkeleton,
  FactoryLoadError,
  FactoryRowLink,
  ROW_LINK_CLASS,
} from "./FactoryPageParts";

const NO_ITEMS: ReadonlyArray<WorkItemSummary> = [];

/** Rows only change when an item or its run thread's settled or archived state does. */
const needsYouAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((factoryId: FactoryId) => {
    const select = createNeedsYouSelector();
    return Atom.make((get) => {
      const inputs = needsYouListInputs(factoryId);
      const list = (input: (typeof inputs)[keyof typeof inputs]) =>
        AsyncResult.getOrElse(
          get(factoriesEnvironment.workItems({ environmentId, input })),
          () => null,
        )?.workItems ?? NO_ITEMS;
      return select({
        environmentId,
        waiting: list(inputs.waiting),
        failed: list(inputs.failed),
        shells: get(environmentThreadShells.threadShellsAtom),
      });
    }).pipe(Atom.withLabel(`web-factory-needs-you:${environmentId}:${factoryId}`));
  }),
);

function NeedsYouRowLink(props: {
  readonly environmentId: EnvironmentId;
  readonly factoryId: FactoryId;
  readonly row: NeedsYouRow;
}) {
  const gt = useGT();
  const { item } = props.row;
  const threadId = item.foremanThreadId;
  return (
    <FactoryRowLink
      title={item.title}
      meta={
        props.row.kind === "failure"
          ? gt("Failed", { $context: "work item stage" })
          : item.gate.state === "waiting"
            ? item.gate.question
            : gt("Waiting", { $context: "work item stage, a gate holds it for a person" })
      }
      trailing={
        <span className="text-xs text-muted-foreground">
          <RelativeTime timestamp={item.updatedAt} />
        </span>
      }
      link={
        threadId === null ? (
          <Link
            to={FACTORY_ROUTE}
            params={{ environmentId: props.environmentId, factoryId: props.factoryId }}
            search={{ tab: "work-items", item: item.id }}
            className={ROW_LINK_CLASS}
            aria-label={item.title}
          />
        ) : (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: props.environmentId, threadId }}
            className={ROW_LINK_CLASS}
            aria-label={item.title}
          />
        )
      }
    />
  );
}

/** Gates to answer and failures to acknowledge; each row opens the item's run thread. */
function NeedsYou(props: { readonly environmentId: EnvironmentId; readonly factoryId: FactoryId }) {
  const gt = useGT();
  const { environmentId, factoryId } = props;
  const inputs = needsYouListInputs(factoryId);
  const waiting = useEnvironmentQuery(
    factoriesEnvironment.workItems({ environmentId, input: inputs.waiting }),
  );
  const failed = useEnvironmentQuery(
    factoriesEnvironment.workItems({ environmentId, input: inputs.failed }),
  );
  const rows = useAtomValue(needsYouAtom(environmentId)(factoryId));
  const error = waiting.error ?? failed.error;
  if (error !== null && (waiting.data === null || failed.data === null)) {
    return (
      <SettingsSection title={gt("Needs you")}>
        <FactoryLoadError
          title={gt("Could not load work items")}
          message={error}
          onRetry={() => factoriesEnvironment.refresh(appAtomRegistry, environmentId)}
        />
      </SettingsSection>
    );
  }
  if (waiting.data === null || failed.data === null) return <FactoryCardSkeleton rows={2} />;
  return (
    <SettingsSection title={gt("Needs you")}>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          <T>Nothing needs you right now</T>
        </p>
      ) : (
        rows.map((row) => (
          <NeedsYouRowLink
            key={row.item.id}
            environmentId={environmentId}
            factoryId={factoryId}
            row={row}
          />
        ))
      )}
    </SettingsSection>
  );
}

export function FactoryOverviewTab(props: FactoryTabProps) {
  return (
    <>
      <FactoryCanvas environmentId={props.environmentId} factoryId={props.factory.id} />
      <NeedsYou environmentId={props.environmentId} factoryId={props.factory.id} />
    </>
  );
}
