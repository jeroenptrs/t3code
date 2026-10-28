import { useAtomValue } from "@effect/atom-react";
import { secondTick } from "@t3tools/client-runtime/clock";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useCallback, useMemo, useState, useSyncExternalStore, type Ref } from "react";
import { FlatList, StyleSheet, Text, TVFocusGuideView, View } from "react-native";

import { FocusablePressable, type FocusableHost } from "../../components/FocusablePressable";
import {
  colors,
  pullRequestColors,
  statusColors,
  typeScale,
  typography,
} from "../../components/theme";
import {
  environmentProjects,
  environmentSummaries,
  environmentThreadShells,
  providerNamesAtom,
  threadListCapabilitiesAtom,
} from "../../state/environments";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import type { ThreadRef } from "../../navigation/stack";
import { useDevOpenThread } from "../threads/devOpenThread";
import {
  buildThreadSections,
  SETTLED_INITIAL_COUNT,
  SETTLED_PAGE_COUNT,
  shelfHeaderLabel,
  threadPullRequestBadge,
  type ThreadListEntry,
  type ThreadShelf,
  type ThreadStatusChip,
} from "./threadSections";
import { useListNow } from "./useListNow";

// Module scope so a thread that just stopped working keeps its place across screens.
const inboxReturns = createInboxReturnTracker();

interface FilterOption<T> {
  readonly value: T;
  readonly label: string;
}

/**
 * The sidebar's threads across environments in mobile's sections (pinned and active rows, then
 * the Working, Snoozed, and Settled shelves), under environment and project filters.
 */
export function ThreadSectionList({
  selectedRowRef,
  filterRef,
  ...props
}: {
  /** Controlled, so the `environment/<id>` link can set it. */
  readonly environmentFilter: EnvironmentId | null;
  readonly onEnvironmentFilterChange: (environmentId: EnvironmentId | null) => void;
  readonly selectedThread: ThreadRef | null;
  readonly onSelectThread: (thread: ThreadRef) => void;
  /** Attached to the selected row while it is mounted, for focus guide destinations. */
  readonly selectedRowRef: Ref<FocusableHost>;
  /** The environment filter, where focus lands when no selected row is mounted. */
  readonly filterRef: Ref<FocusableHost>;
}) {
  // Quiet shells keep their identity while a run streams, so the list rebuilds only when a
  // thread's placement or status can change, never per streamed chunk.
  const threads = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  const { settlementEnvironmentIds, snoozeEnvironmentIds } = useAtomValue(
    threadListCapabilitiesAtom,
  );
  const providerNames = useAtomValue(providerNamesAtom);
  const now = useListNow(threads);

  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<ThreadShelf, boolean>>({
    working: true,
    snoozed: false,
    settled: true,
  });
  const [settledLimit, setSettledLimit] = useState(SETTLED_INITIAL_COUNT);

  const environmentOptions = useMemo(
    (): ReadonlyArray<FilterOption<EnvironmentId | null>> => [
      { value: null, label: "All environments" },
      ...environments
        .map((environment) => ({
          value: environment.environmentId,
          label: environment.environmentLabel,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    ],
    [environments],
  );
  const scopeEnvironmentId = environmentOptions.some(
    (option) => option.value === props.environmentFilter,
  )
    ? props.environmentFilter
    : null;
  const selectedKey = props.selectedThread
    ? `${props.selectedThread.environmentId}:${props.selectedThread.threadId}`
    : null;

  const projectGroups = useMemo(
    () =>
      buildProjectGroups({
        projects: projects.filter(
          (project) => scopeEnvironmentId === null || project.environmentId === scopeEnvironmentId,
        ),
        groupScratchProjects: true,
        settings: {
          sidebarProjectGroupingMode: "repository",
          sidebarProjectGroupingOverrides: {},
        },
      }),
    [projects, scopeEnvironmentId],
  );
  const projectOptions = useMemo(
    (): ReadonlyArray<FilterOption<string | null>> => [
      { value: null, label: "All projects" },
      ...projectGroups.map((group) => ({ value: group.key, label: group.label })),
    ],
    [projectGroups],
  );
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey) ?? null;
  const projectRefs = selectedGroup?.memberProjectRefs ?? null;

  const inboxVersion = useSyncExternalStore(inboxReturns.subscribe, inboxReturns.getSnapshot);
  const inbox = useMemo(
    () => inboxReturns.observe(threads),
    // oxlint-disable-next-line react/memo-dependencies -- the version signals an expired grace
    [threads, inboxVersion],
  );

  const scopes = useMemo((): ReadonlyArray<OlderSettledScope> => {
    const environmentIds =
      scopeEnvironmentId === null ? [...settlementEnvironmentIds] : [scopeEnvironmentId];
    return environmentIds.flatMap((environmentId): ReadonlyArray<OlderSettledScope> => {
      if (projectRefs === null) return [{ environmentId, projectIds: null }];
      const projectIds = projectRefs.flatMap((ref) =>
        ref.environmentId === environmentId ? [ref.projectId] : [],
      );
      return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
    });
  }, [projectRefs, scopeEnvironmentId, settlementEnvironmentIds]);
  const olderSettled = useOlderSettledShelf({
    scopes,
    expanded: expanded.settled,
    visibleCount: settledLimit,
  });

  const sections = buildThreadSections({
    threads,
    environmentId: scopeEnvironmentId,
    projectRefs,
    now,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    expanded,
    settledLimit,
    selectedThreadKey: selectedKey,
    isWorking: inbox.isWorking,
    inboxReturnAt: inbox.returnedAt,
    isListedSettled: olderSettled.isListed,
    unloadedSettledCount: olderSettled.unloadedCount(
      threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          scopes.some(
            (scope) =>
              scope.environmentId === thread.environmentId &&
              (scope.projectIds === null || scope.projectIds.includes(thread.projectId)),
          ),
      ),
    ),
  });
  useOlderSettledShelfGrowth(olderSettled, sections.listedSettledThreads);

  const environmentLabels = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) => [environment.environmentId, environment.environmentLabel] as const,
        ),
      ),
    [environments],
  );
  const projectTitles = useMemo(
    () =>
      new Map(
        projects.map(
          (project) => [`${project.environmentId}:${project.id}`, project.title] as const,
        ),
      ),
    [projects],
  );
  const showEnvironment = scopeEnvironmentId === null && environments.length > 1;

  const toggleShelf = useCallback((shelf: ThreadShelf) => {
    setExpanded((current) => ({ ...current, [shelf]: !current[shelf] }));
    if (shelf === "settled") setSettledLimit(SETTLED_INITIAL_COUNT);
  }, []);
  const showMore = useCallback(() => setSettledLimit((limit) => limit + SETTLED_PAGE_COUNT), []);

  const { onSelectThread } = props;
  const visibleThreadIdsKey = sections.entries
    .flatMap((entry) => (entry.type === "thread" ? [entry.thread.id] : []))
    .join("\n");
  const visibleThreadIds = useMemo(
    () => (visibleThreadIdsKey === "" ? [] : (visibleThreadIdsKey.split("\n") as ThreadId[])),
    [visibleThreadIdsKey],
  );
  useDevOpenThread(visibleThreadIds, (threadId) => {
    const entry = sections.entries.find(
      (candidate) => candidate.type === "thread" && candidate.thread.id === threadId,
    );
    if (entry?.type === "thread") {
      onSelectThread({ environmentId: entry.thread.environmentId, threadId });
    }
  });
  const onSelect = useCallback(
    (thread: EnvironmentThreadShell) =>
      onSelectThread({ environmentId: thread.environmentId, threadId: thread.id }),
    [onSelectThread],
  );

  const renderItem = ({ item }: { readonly item: ThreadListEntry }) => {
    if (item.type === "header") {
      return (
        <ShelfHeader
          shelf={item.section}
          count={item.count}
          expanded={item.expanded}
          onToggle={toggleShelf}
        />
      );
    }
    if (item.type === "more") {
      return (
        <FocusablePressable
          style={styles.moreRow}
          focusedStyle={styles.rowFocused}
          onPress={showMore}
        >
          <Text style={styles.moreLabel}>
            {olderSettled.loading ? "Loading…" : `Show more (${item.hiddenCount})`}
          </Text>
        </FocusablePressable>
      );
    }
    const selected = selectedKey === `${item.thread.environmentId}:${item.thread.id}`;
    return (
      <ThreadRow
        ref={selected ? selectedRowRef : undefined}
        thread={item.thread}
        slim={item.section === "snoozed" || item.section === "settled"}
        chip={item.chip}
        timeLabel={item.timeLabel}
        pinned={item.pinned}
        selected={selected}
        environmentLabel={showEnvironment ? environmentLabels.get(item.thread.environmentId) : null}
        projectTitle={projectTitles.get(`${item.thread.environmentId}:${item.thread.projectId}`)}
        providerName={providerNames.get(
          `${item.thread.environmentId}:${item.thread.runtime?.providerInstanceId ?? item.thread.modelSelection.instanceId}`,
        )}
        onSelect={onSelect}
      />
    );
  };

  const anyConnected = environments.some(
    (environment) => environment.connectionState === "connected",
  );

  return (
    <View style={styles.root}>
      <TVFocusGuideView style={styles.filters} autoFocus>
        <FilterChip
          ref={filterRef}
          options={environmentOptions}
          value={scopeEnvironmentId}
          onChange={(value) => {
            props.onEnvironmentFilterChange(value);
            setSelectedProjectKey(null);
          }}
        />
        <FilterChip
          options={projectOptions}
          value={selectedGroup?.key ?? null}
          onChange={setSelectedProjectKey}
        />
      </TVFocusGuideView>
      {sections.entries.length === 0 ? (
        <Text style={styles.muted}>
          {anyConnected || threads.length > 0 ? "No threads." : "Waiting for an environment…"}
        </Text>
      ) : (
        <TVFocusGuideView style={styles.list} autoFocus>
          <FlatList
            data={sections.entries}
            keyExtractor={(entry) => entry.key}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
          />
        </TVFocusGuideView>
      )}
    </View>
  );
}

/** A chip that cycles its options on select; tvOS has no native menus. */
function FilterChip<T>({
  ref,
  ...props
}: {
  readonly ref?: Ref<FocusableHost>;
  readonly options: ReadonlyArray<FilterOption<T>>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  const index = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.value),
  );
  const active = index > 0;
  return (
    <FocusablePressable
      ref={ref}
      style={[styles.chip, active && styles.chipActive]}
      onPress={() => props.onChange(props.options[(index + 1) % props.options.length]!.value)}
    >
      <Text style={styles.chipLabel} numberOfLines={1}>
        {props.options[index]?.label ?? ""}
        {props.options.length > 2 ? `  ${index + 1}/${props.options.length}` : ""}
      </Text>
    </FocusablePressable>
  );
}

/** Mobile's shelf divider: label, rule, and a chevron that points the way the shelf will move. */
const ShelfHeader = memo(function ShelfHeader(props: {
  readonly shelf: ThreadShelf;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: (shelf: ThreadShelf) => void;
}) {
  const snoozed = props.shelf === "snoozed";
  return (
    <FocusablePressable
      style={styles.shelfHeader}
      focusedStyle={styles.rowFocused}
      onPress={() => props.onToggle(props.shelf)}
    >
      <Text style={[styles.shelfLabel, snoozed && styles.shelfLabelSnoozed]}>
        {shelfHeaderLabel(props.shelf, props.count, props.expanded)}
      </Text>
      <View style={[styles.shelfRule, snoozed && styles.shelfRuleSnoozed]} />
      <View style={[styles.chevron, props.expanded && styles.chevronUp]} />
    </FocusablePressable>
  );
});

/** A pushpin drawn in views, mobile's `pin` symbol; the TV has no symbol font to draw it with. */
function PinGlyph(props: { readonly color: string }) {
  return (
    <View style={styles.pin}>
      <View style={[styles.pinHead, { backgroundColor: props.color }]} />
      <View style={[styles.pinBase, { backgroundColor: props.color }]} />
      <View style={[styles.pinNeedle, { backgroundColor: props.color }]} />
    </View>
  );
}

/** Seconds since `startedAt`, on the shared one-second tick; only this text re-renders. */
function LiveDuration(props: { readonly startedAt: string | null }) {
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const live = Number.isFinite(startedAtMs);
  const nowMs = useSyncExternalStore(
    live ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
  );
  return live ? ` ${formatWorkingDurationLabel(nowMs - startedAtMs)}` : null;
}

const subscribeNever = () => () => undefined;

// Rows take only values that change with what they show, so a rebuilt list re-renders just
// the rows whose thread, status, time, or selection changed.
const ThreadRow = memo(function ThreadRow({
  ref,
  ...props
}: {
  readonly ref?: Ref<FocusableHost>;
  readonly thread: EnvironmentThreadShell;
  readonly slim: boolean;
  readonly chip: ThreadStatusChip | null;
  readonly timeLabel: string;
  readonly pinned: boolean;
  readonly selected: boolean;
  readonly environmentLabel: string | null | undefined;
  readonly projectTitle: string | undefined;
  readonly providerName: string | undefined;
  readonly onSelect: (thread: EnvironmentThreadShell) => void;
}) {
  const { thread, chip, selected } = props;
  const rowStyle = [styles.row, selected && styles.rowSelected];
  const focusedStyle = selected ? styles.rowSelected : styles.rowFocused;
  const title = thread.title || "Untitled thread";
  const mutedColor = selected ? colors.selectedTextMuted : colors.textTertiary;

  if (props.slim) {
    return (
      <FocusablePressable
        ref={ref}
        style={rowStyle}
        focusedStyle={focusedStyle}
        onPress={() => props.onSelect(thread)}
      >
        <View style={styles.rowLine}>
          <Text
            style={[styles.slimTitle, selected && { color: colors.selectedText }]}
            numberOfLines={1}
          >
            {title}
          </Text>
          <Text style={[styles.time, { color: mutedColor }]}>{props.timeLabel}</Text>
        </View>
      </FocusablePressable>
    );
  }

  const failure =
    (chip?.tone === "failed" || chip?.tone === "limited") && thread.runtime?.lastError
      ? thread.runtime.lastError
      : null;
  const pr = threadPullRequestBadge(thread);
  const place = [props.projectTitle, props.environmentLabel].filter(Boolean).join(" · ");
  // Mobile recedes rows a run is busy with until they need the reader again.
  const recede = !selected && chip?.duration != null;
  const chipColor =
    chip === null ? mutedColor : selected ? colors.selectedText : statusColors[chip.tone];
  return (
    <FocusablePressable
      ref={ref}
      style={rowStyle}
      focusedStyle={focusedStyle}
      onPress={() => props.onSelect(thread)}
    >
      <View style={recede ? styles.receded : undefined}>
        <View style={styles.rowLine}>
          <Text
            style={[
              styles.title,
              recede && styles.titleReceded,
              selected && { color: colors.selectedText },
            ]}
            numberOfLines={2}
          >
            {title}
          </Text>
          <View style={styles.trailing}>
            {props.pinned ? <PinGlyph color={mutedColor} /> : null}
            {chip ? (
              <Text style={[styles.chipText, { color: chipColor }]}>
                {chip.label}
                {chip.duration === "working" ? (
                  <LiveDuration startedAt={resolveThreadWorkingStartedAt(thread)} />
                ) : chip.duration === "waiting" ? (
                  <LiveDuration startedAt={thread.latestRun?.completedAt ?? null} />
                ) : null}
              </Text>
            ) : (
              <Text style={[styles.time, { color: mutedColor }]}>{props.timeLabel}</Text>
            )}
          </View>
        </View>
        <View style={styles.rowLine}>
          {failure !== null ? (
            <Text
              style={[
                styles.meta,
                { color: selected ? colors.selectedTextMuted : statusColors[chip!.tone] },
              ]}
              numberOfLines={1}
            >
              {failure}
            </Text>
          ) : (
            <Text style={[styles.meta, { color: mutedColor }]} numberOfLines={1}>
              {place}
            </Text>
          )}
          {pr ? (
            <Text style={[styles.pullRequest, { color: pullRequestColors[pr.tone] }]}>
              #{pr.number}
            </Text>
          ) : null}
          {props.providerName ? (
            <Text style={[styles.provider, { color: mutedColor }]} numberOfLines={1}>
              {props.providerName}
            </Text>
          ) : null}
        </View>
      </View>
    </FocusablePressable>
  );
});

const ROW_RADIUS = 22;

const styles = StyleSheet.create({
  root: { flex: 1 },
  filters: { flexDirection: "row", gap: 14, marginBottom: 16, paddingHorizontal: 8 },
  chip: { flexShrink: 1, paddingHorizontal: 22, paddingVertical: 12 },
  chipActive: { borderColor: colors.accent },
  chipLabel: { color: colors.text, ...typeScale.xs, fontWeight: "600" },
  list: { flex: 1 },
  listContent: { gap: 4, paddingBottom: 48, paddingHorizontal: 8, paddingTop: 4 },
  shelfHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    backgroundColor: "transparent",
    borderRadius: ROW_RADIUS,
    marginTop: 20,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  shelfLabel: { color: colors.textTertiary, ...typeScale.xs, fontWeight: "500" },
  shelfLabelSnoozed: { color: colors.textMuted },
  shelfRule: { flex: 1, height: 2, backgroundColor: colors.border },
  shelfRuleSnoozed: { backgroundColor: "rgba(52, 107, 241, 0.2)" },
  chevron: {
    width: 14,
    height: 14,
    marginBottom: 6,
    borderRightWidth: 3,
    borderBottomWidth: 3,
    borderColor: colors.textMuted,
    transform: [{ rotate: "45deg" }],
  },
  chevronUp: { marginBottom: -6, transform: [{ rotate: "-135deg" }] },
  row: {
    backgroundColor: "transparent",
    borderRadius: ROW_RADIUS,
    gap: 6,
    paddingHorizontal: 22,
    paddingVertical: 16,
  },
  rowSelected: { backgroundColor: colors.selected },
  rowFocused: { backgroundColor: colors.rowHover },
  receded: { opacity: 0.55 },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 16 },
  title: { flex: 1, color: colors.text, ...typeScale.base, fontWeight: "500" },
  titleReceded: { fontWeight: "400" },
  slimTitle: { flex: 1, color: colors.textMuted, ...typeScale.base },
  trailing: { flexDirection: "row", alignItems: "center", gap: 12, alignSelf: "flex-start" },
  chipText: { ...typeScale.xs, fontWeight: "700", fontVariant: ["tabular-nums"] },
  time: {
    ...typeScale.xs,
    fontFamily: typography.monospaceFamily,
    fontVariant: ["tabular-nums"],
  },
  meta: { flex: 1, ...typeScale.xs },
  pullRequest: { ...typeScale.xs, fontFamily: typography.monospaceFamily },
  provider: { ...typeScale.xs, flexShrink: 0, maxWidth: 200 },
  pin: { width: 18, height: 22, alignItems: "center", transform: [{ rotate: "45deg" }] },
  pinHead: { width: 10, height: 9, borderRadius: 2 },
  pinBase: { width: 16, height: 3, borderRadius: 1.5 },
  pinNeedle: { width: 2, height: 9 },
  moreRow: {
    alignSelf: "flex-start",
    backgroundColor: "transparent",
    borderRadius: ROW_RADIUS,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  moreLabel: { color: colors.textMuted, ...typeScale.sm, fontWeight: "600" },
  muted: { color: colors.textMuted, ...typeScale.sm, paddingHorizontal: 22 },
});
