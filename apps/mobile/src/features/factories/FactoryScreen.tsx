/**
 * Fork-only. One factory on mobile: what needs the person, its work items, and its roles' switches.
 * Authoring the definition stays on web.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  canSaveDefinition,
  factoryRoleLabel,
  factorySaveInput,
  WORK_ITEM_STAGES,
  needsYouListInputs,
  roleEnabledChange,
  WORK_ITEM_OUTCOME_LABELS,
  workItemStageLabel,
  type NeedsYouRow,
} from "@t3tools/client-runtime/factories";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  FACTORY_FOREMAN_ROLE,
  FactoryError,
  FactoryId,
  parseFactoryId,
  WorkItemOutcome,
  type Factory,
  type FactoryRole,
  type WorkItem,
  type WorkItemId,
  type WorkItemStage,
  type WorkItemSummary,
} from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { RelativeTime } from "../../components/RelativeTime";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig } from "../../state/entities";
import { factoriesEnvironment, factoryNeedsYouAtom, useFactoryAccess } from "../../state/factories";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { factoryModelLabel } from "./FactoryScreen.logic";
import { NewWorkItemSheet, WorkItemSheet, WorkItemStageText } from "./WorkItemSheet";

type FactoryView = "overview" | "work-items" | "roles";

const VIEW_LABELS: Record<FactoryView, string> = {
  overview: msg("Overview", { $context: "factory page tab" }),
  "work-items": msg("Work items", { $context: "factory page tab" }),
  roles: msg("Roles", { $context: "factory page tab" }),
};

interface WorkItemFilter {
  readonly stage?: WorkItemStage;
  readonly outcome?: WorkItemOutcome;
}

const isFactoryError = Schema.is(FactoryError);

type FactoryScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly factoryId: string;
}>;

export function FactoryScreen({ route }: FactoryScreenProps) {
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const factoryId = FactoryId.make(route.params.factoryId);
  const access = useFactoryAccess(environmentId);
  const selectDetail = useSelectWorkspaceDetail();
  const [view, setView] = useState<FactoryView>("overview");
  const [filter, setFilter] = useState<WorkItemFilter>({});
  const [openItem, setOpenItem] = useState<WorkItemId | null>(null);
  const [creating, setCreating] = useState(false);
  const read = useEnvironmentQuery(
    access.canRead ? factoriesEnvironment.read({ environmentId, input: { factoryId } }) : null,
  );
  const workItems = useEnvironmentQuery(
    access.canRead && view === "work-items"
      ? factoriesEnvironment.workItems({ environmentId, input: { factoryId, ...filter } })
      : null,
  );
  const canCreate = useAtomValue(factoriesEnvironment.createWorkItem.permissionAtom(environmentId));
  // The read refreshes after a save lands; until it does, show what the save returned.
  const [saved, setSaved] = useState<{ readonly from: Factory; readonly to: Factory } | null>(null);
  const factory = read.data !== null && saved?.from === read.data ? saved.to : read.data;
  const notFound =
    isFactoryError(read.failure) &&
    (read.failure.code === "not_found" || read.failure.code === "project_not_found");
  const title = factory?.name ?? parseFactoryId(factoryId)?.name ?? route.params.factoryId;
  const refresh = () => factoriesEnvironment.refresh(appAtomRegistry, environmentId);
  const filtered = filter.stage !== undefined || filter.outcome !== undefined;
  // An empty factory offers its first item in the empty state; there is nothing to filter yet.
  const emptyFactory = workItems.data?.workItems.length === 0 && !filtered;
  const workItemsToolbar = view === "work-items" && factory !== null && !emptyFactory;

  const openThread = (item: WorkItem) => {
    if (item.foremanThreadId === null) return;
    setOpenItem(null);
    selectDetail({
      name: "Thread",
      params: { environmentId: String(environmentId), threadId: String(item.foremanThreadId) },
    });
  };

  const actions: ReadonlyArray<AppBarAction> =
    workItemsToolbar && canCreate
      ? [
          {
            accessibilityLabel: gt("New work item"),
            icon: "plus",
            onPress: () => setCreating(true),
          },
        ]
      : [];
  const filterMenu: AppBarMenu | null =
    workItemsToolbar && factory !== null
      ? {
          title: gt("Filter work items"),
          icon: filtered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease",
          items: [
            {
              id: "stage",
              title:
                filter.stage === undefined
                  ? gt("Any stage")
                  : workItemStageLabel(filter.stage, messages),
              items: [
                {
                  id: "stage:any",
                  title: gt("Any stage"),
                  selected: filter.stage === undefined,
                  onPress: () => setFilter(({ stage: _stage, ...rest }) => rest),
                },
                ...WORK_ITEM_STAGES.map((stage) => ({
                  id: `stage:${stage}`,
                  title: workItemStageLabel(stage, messages),
                  selected: filter.stage === stage,
                  onPress: () => setFilter((current) => ({ ...current, stage })),
                })),
              ],
            },
            {
              id: "outcome",
              title:
                filter.outcome === undefined
                  ? gt("Any outcome")
                  : messages(WORK_ITEM_OUTCOME_LABELS[filter.outcome]),
              items: [
                {
                  id: "outcome:any",
                  title: gt("Any outcome"),
                  selected: filter.outcome === undefined,
                  onPress: () => setFilter(({ outcome: _outcome, ...rest }) => rest),
                },
                ...WorkItemOutcome.literals.map((outcome) => ({
                  id: `outcome:${outcome}`,
                  title: messages(WORK_ITEM_OUTCOME_LABELS[outcome]),
                  selected: filter.outcome === outcome,
                  onPress: () => setFilter((current) => ({ ...current, outcome })),
                })),
              ],
            },
          ],
        }
      : null;

  const content = !access.loaded ? (
    <RowsSkeleton rows={3} />
  ) : !access.canRead ? (
    <EmptyState
      variant="plain"
      title={gt("No access to factories")}
      detail={gt("Factories need an operator or administrator role on this environment.")}
    />
  ) : notFound ? (
    <EmptyState
      variant="plain"
      title={gt("Factory not found")}
      detail={gt("Its folder under .t3/factories was renamed or removed, or its project is gone.")}
    />
  ) : factory === null ? (
    read.error === null ? (
      <RowsSkeleton rows={3} />
    ) : (
      <LoadError title={gt("Could not load the factory")} message={read.error} onRetry={refresh} />
    )
  ) : (
    <>
      <SegmentedControl
        options={(["overview", "work-items", "roles"] as const).map((value) => ({
          value,
          label: messages(VIEW_LABELS[value]),
        }))}
        selected={view}
        onSelect={setView}
        role="tab"
      />
      {view === "overview" ? (
        <NeedsYou environmentId={environmentId} factoryId={factoryId} onOpen={setOpenItem} />
      ) : view === "work-items" ? (
        <WorkItems
          environmentId={environmentId}
          query={workItems}
          filtered={filtered}
          canCreate={canCreate}
          onCreate={() => setCreating(true)}
          onClearFilter={() => setFilter({})}
          onRetry={refresh}
          onOpen={setOpenItem}
        />
      ) : (
        <Roles
          environmentId={environmentId}
          factory={factory}
          canManage={access.canManage}
          onSaved={(next) => {
            if (read.data !== null) setSaved({ from: read.data, to: next });
          }}
        />
      )}
    </>
  );

  return (
    <SettingsScreen
      title={title}
      actions={actions}
      menus={filterMenu === null ? undefined : [filterMenu]}
      refresh={
        access.canRead && !notFound
          ? { accessibilityLabel: gt("Refresh factory"), onPress: refresh }
          : undefined
      }
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          access.canRead && !notFound ? (
            <RefreshControl refreshing={false} onRefresh={refresh} />
          ) : undefined
        }
      >
        {content}
      </ScrollView>
      {openItem === null ? null : (
        <WorkItemSheet
          key={openItem}
          environmentId={environmentId}
          workItemId={openItem}
          onOpenThread={openThread}
          onClose={() => setOpenItem(null)}
        />
      )}
      {creating ? (
        <NewWorkItemSheet
          environmentId={environmentId}
          factoryId={factoryId}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </SettingsScreen>
  );
}

function RowsSkeleton(props: { readonly rows: number }) {
  const gt = useGT();
  return (
    <View accessibilityLabel={gt("Loading")} accessibilityState={{ busy: true }}>
      <SettingsSection>
        <SkeletonRows rows={props.rows} />
      </SettingsSection>
    </View>
  );
}

function LoadError(props: {
  readonly title: string;
  readonly message: string;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  return (
    <View className="gap-3 rounded-2xl bg-grouped-card p-4">
      <Text textRole="body" className="font-t3-medium text-foreground">
        {props.title}
      </Text>
      <Text selectable textRole="footnote" className="text-danger-foreground">
        {props.message}
      </Text>
      <View className="self-start">
        <Button label={gt("Retry")} size="compact" onPress={props.onRetry} />
      </View>
    </View>
  );
}

/** A work item row: the title over what it waits on, and when it last changed. It opens the sheet. */
function ItemRow(props: {
  readonly item: WorkItemSummary;
  readonly first: boolean;
  readonly meta: ReactNode;
  readonly accessibilityHint: string;
  readonly onPress: () => void;
}) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={props.item.title}
      accessibilityHint={props.accessibilityHint}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={props.first ? "bg-grouped-card" : "border-t border-border-subtle bg-grouped-card"}
    >
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text textRole="body" className="text-foreground" numberOfLines={1}>
            {props.item.title}
          </Text>
          {props.meta}
        </View>
        <Text textRole="footnote" className="text-foreground-muted">
          <RelativeTime timestamp={props.item.updatedAt} />
        </Text>
      </View>
    </RowPressable>
  );
}

/** Gates to answer and failures to acknowledge, by the same rule as web and the server's count. */
function NeedsYou(props: {
  readonly environmentId: EnvironmentId;
  readonly factoryId: FactoryId;
  readonly onOpen: (workItemId: WorkItemId) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, factoryId } = props;
  const inputs = needsYouListInputs(factoryId);
  const waiting = useEnvironmentQuery(
    factoriesEnvironment.workItems({ environmentId, input: inputs.waiting }),
  );
  const failed = useEnvironmentQuery(
    factoriesEnvironment.workItems({ environmentId, input: inputs.failed }),
  );
  const describe = (row: NeedsYouRow) =>
    row.kind === "failure"
      ? workItemStageLabel("failed", messages)
      : row.item.gate.state === "waiting"
        ? row.item.gate.question
        : workItemStageLabel("waiting", messages);
  const rows = useAtomValue(factoryNeedsYouAtom(environmentId)(factoryId));
  const error = waiting.error ?? failed.error;
  const loaded = waiting.data !== null && failed.data !== null;
  return (
    <SettingsSection title={gt("Needs you")}>
      {loaded ? (
        rows.length === 0 ? (
          <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
            <T>Nothing needs you right now</T>
          </Text>
        ) : (
          rows.map((row, index) => (
            <ItemRow
              key={row.item.id}
              item={row.item}
              first={index === 0}
              accessibilityHint={describe(row)}
              meta={
                <Text
                  textRole="footnote"
                  className={
                    row.kind === "failure" ? "text-danger-foreground" : "text-foreground-muted"
                  }
                  numberOfLines={2}
                >
                  {describe(row)}
                </Text>
              }
              onPress={() => props.onOpen(row.item.id)}
            />
          ))
        )
      ) : error !== null ? (
        <View className="gap-3 p-4">
          <Text selectable textRole="footnote" className="text-danger-foreground">
            {error}
          </Text>
          <View className="self-start">
            <Button
              label={gt("Retry")}
              size="compact"
              onPress={() => factoriesEnvironment.refresh(appAtomRegistry, environmentId)}
            />
          </View>
        </View>
      ) : (
        <SkeletonRows rows={2} />
      )}
    </SettingsSection>
  );
}

function SkeletonRows(props: { readonly rows: number }) {
  return Array.from({ length: props.rows }, (_, index) => (
    <View
      key={index}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      className={
        index === 0
          ? "min-h-14 justify-center gap-2 px-4 py-3"
          : "min-h-14 justify-center gap-2 border-t border-border-subtle px-4 py-3"
      }
    >
      <View
        className="h-3.5 rounded bg-subtle-strong"
        style={{ width: index % 2 ? "55%" : "70%" }}
      />
      <View className="h-2.5 w-1/4 rounded bg-subtle-strong" />
    </View>
  ));
}

function WorkItems(props: {
  readonly environmentId: EnvironmentId;
  readonly query: EnvironmentQueryView<{ readonly workItems: ReadonlyArray<WorkItemSummary> }>;
  readonly filtered: boolean;
  readonly canCreate: boolean;
  readonly onCreate: () => void;
  readonly onClearFilter: () => void;
  readonly onRetry: () => void;
  readonly onOpen: (workItemId: WorkItemId) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const items = props.query.data?.workItems ?? null;
  if (items === null) {
    return props.query.error === null ? (
      <RowsSkeleton rows={4} />
    ) : (
      <LoadError
        title={gt("Could not load work items")}
        message={props.query.error}
        onRetry={props.onRetry}
      />
    );
  }
  if (items.length === 0 && !props.filtered) {
    return (
      <EmptyState
        variant="plain"
        title={gt("No work items yet")}
        detail={gt("Send the factory a request, or attach a trigger that sends them.")}
        {...(props.canCreate ? { actionLabel: gt("New work item"), onAction: props.onCreate } : {})}
      />
    );
  }
  if (items.length === 0) {
    return (
      <View className="items-center gap-3 py-6">
        <Text textRole="footnote" className="text-foreground-muted">
          <T>No work items match these filters</T>
        </Text>
        <Button label={gt("Clear filters")} size="compact" onPress={props.onClearFilter} />
      </View>
    );
  }
  return (
    <SettingsSection>
      {items.map((item, index) => (
        <ItemRow
          key={item.id}
          item={item}
          first={index === 0}
          accessibilityHint={workItemStageLabel(item.stage, messages)}
          meta={<WorkItemStageText environmentId={props.environmentId} item={item} />}
          onPress={() => props.onOpen(item.id)}
        />
      ))}
    </SettingsSection>
  );
}

/** Each role with its model; a switch turns a role on or off at once. The Foreman has none. */
function Roles(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly canManage: boolean;
  readonly onSaved: (factory: Factory) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, factory } = props;
  const providers = useEnvironmentServerConfig(environmentId)?.providers ?? [];
  const canSave =
    useAtomValue(factoriesEnvironment.save.permissionAtom(environmentId)) && props.canManage;
  const blocked = !canSaveDefinition(factory);
  const save = useAtomCommand(factoriesEnvironment.save, {
    label: "save a factory",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);

  const toggle = async (role: FactoryRole, enabled: boolean) => {
    if (saving) return;
    setSaving(true);
    const result = await save({
      environmentId,
      input: factorySaveInput(factory, { roles: [roleEnabledChange(role, enabled)] }),
    });
    setSaving(false);
    if (result._tag === "Success") {
      props.onSaved(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      enabled ? gt("Could not turn the role on") : gt("Could not turn the role off"),
      error instanceof Error && error.message !== ""
        ? error.message
        : gt("The factory could not be saved."),
    );
  };

  return (
    <SettingsSection
      title={gt("Roles")}
      footer={
        canSave && blocked ? gt("Fix factory.json before saving. It could not be read.") : undefined
      }
    >
      {factory.roles.map((role, index) => {
        const label = factoryRoleLabel(role.role, messages);
        // The model, then what the role is for, as the Foreman is told it.
        const model = [factoryModelLabel(role.binding.model, providers, messages), role.description]
          .filter((part) => part !== "")
          .join(" · ");
        return (
          <View
            key={role.role}
            className={index === 0 ? undefined : "border-t border-border-subtle"}
          >
            {role.role === FACTORY_FOREMAN_ROLE || !canSave ? (
              <ListRowLayout label={label} description={model} />
            ) : (
              <ListToggleRow
                label={label}
                description={model}
                value={role.enabled}
                disabled={blocked}
                onValueChange={(enabled) => void toggle(role, enabled)}
              />
            )}
          </View>
        );
      })}
    </SettingsSection>
  );
}
