import { useAtomValue } from "@effect/atom-react";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { FlatList, StyleSheet, Text, TVFocusGuideView, View } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { colors, statusColors } from "../../components/theme";
import {
  environmentProjects,
  environmentSummaries,
  environmentThreadShells,
  threadListCapabilitiesAtom,
} from "../../state/environments";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import { useDevOpenThread } from "../threads/devOpenThread";
import {
  buildThreadSections,
  SECTION_LABELS,
  SETTLED_INITIAL_COUNT,
  SETTLED_PAGE_COUNT,
  type ThreadListEntry,
  type ThreadSection,
  type ThreadStatusChip,
} from "./threadSections";
import { useListNow } from "./useListNow";

// Module scope so a thread that just stopped working keeps its place across screens.
const inboxReturns = createInboxReturnTracker();

type Shelf = "working" | "snoozed" | "settled";

interface FilterOption<T> {
  readonly value: T;
  readonly label: string;
}

/**
 * Threads across environments in mobile's Home sections (active, working, snoozed, settled),
 * with environment and project filters. `environmentId` fixes the scope to one environment.
 */
export function ThreadSectionList(props: {
  readonly environmentId: EnvironmentId | null;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  // Quiet shells keep their identity while a run streams, so the list rebuilds only when a
  // thread's placement or status can change, never per streamed chunk.
  const threads = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  const { settlementEnvironmentIds, snoozeEnvironmentIds } = useAtomValue(
    threadListCapabilitiesAtom,
  );
  const now = useListNow(threads);

  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<Shelf, boolean>>({
    working: true,
    snoozed: false,
    settled: false,
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
  const scopeEnvironmentId =
    props.environmentId ??
    (environmentOptions.some((option) => option.value === selectedEnvironmentId)
      ? selectedEnvironmentId
      : null);

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
  const showEnvironment = props.environmentId === null && environments.length > 1;

  const toggleShelf = useCallback((shelf: Shelf) => {
    setExpanded((current) => ({ ...current, [shelf]: !current[shelf] }));
    if (shelf === "settled") setSettledLimit(SETTLED_INITIAL_COUNT);
  }, []);
  const showMore = useCallback(() => setSettledLimit((limit) => limit + SETTLED_PAGE_COUNT), []);

  const { onOpenThread } = props;
  const visibleThreads = sections.entries.flatMap((entry) =>
    entry.type === "thread" ? [entry.thread] : [],
  );
  const visibleThreadIdsKey = visibleThreads.map((thread) => thread.id).join("\n");
  const visibleThreadIds = useMemo(
    () => (visibleThreadIdsKey === "" ? [] : (visibleThreadIdsKey.split("\n") as ThreadId[])),
    [visibleThreadIdsKey],
  );
  useDevOpenThread(visibleThreadIds, (threadId) => {
    const thread = visibleThreads.find((candidate) => candidate.id === threadId);
    if (thread) onOpenThread(thread);
  });

  const renderItem = ({ item }: { readonly item: ThreadListEntry }) => {
    if (item.type === "header") {
      return (
        <SectionHeader
          section={item.section}
          count={item.count}
          expanded={item.expanded}
          onToggle={toggleShelf}
        />
      );
    }
    if (item.type === "more") {
      return (
        <FocusablePressable style={styles.moreRow} onPress={showMore}>
          <Text style={styles.moreLabel}>
            {olderSettled.loading ? "Loading…" : `Show more (${item.hiddenCount})`}
          </Text>
        </FocusablePressable>
      );
    }
    return (
      <ThreadRow
        thread={item.thread}
        slim={item.section === "snoozed" || item.section === "settled"}
        chip={item.chip}
        timeLabel={item.timeLabel}
        pinned={item.pinned}
        environmentLabel={showEnvironment ? environmentLabels.get(item.thread.environmentId) : null}
        projectTitle={projectTitles.get(`${item.thread.environmentId}:${item.thread.projectId}`)}
        onOpen={onOpenThread}
      />
    );
  };

  const anyConnected = environments.some(
    (environment) => environment.connectionState === "connected",
  );

  return (
    <View style={styles.root}>
      <TVFocusGuideView style={styles.filters} autoFocus>
        {props.environmentId === null ? (
          <FilterChip
            options={environmentOptions}
            value={scopeEnvironmentId}
            onChange={(value) => {
              setSelectedEnvironmentId(value);
              setSelectedProjectKey(null);
            }}
          />
        ) : null}
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
function FilterChip<T>(props: {
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

const SectionHeader = memo(function SectionHeader(props: {
  readonly section: ThreadSection;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: (shelf: Shelf) => void;
}) {
  const { section } = props;
  const label = `${SECTION_LABELS[section]} · ${props.count}`;
  if (section === "active") {
    return <Text style={styles.sectionTitle}>{label}</Text>;
  }
  return (
    <FocusablePressable style={styles.shelfHeader} onPress={() => props.onToggle(section)}>
      <Text style={styles.sectionTitle}>
        {props.expanded ? "▾ " : "▸ "}
        {label}
      </Text>
    </FocusablePressable>
  );
});

// Rows take only values that change with what they show, so a rebuilt list re-renders just
// the rows whose thread, status, or time changed.
const ThreadRow = memo(function ThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly slim: boolean;
  readonly chip: ThreadStatusChip | null;
  readonly timeLabel: string;
  readonly pinned: boolean;
  readonly environmentLabel: string | null | undefined;
  readonly projectTitle: string | undefined;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const { thread, chip } = props;
  const failure =
    (chip?.tone === "failed" || chip?.tone === "limited") && thread.runtime?.lastError
      ? thread.runtime.lastError
      : null;
  const meta = [props.environmentLabel, props.projectTitle].filter(Boolean).join(" · ");
  return (
    <FocusablePressable
      style={[styles.row, props.slim && styles.slimRow]}
      onPress={() => props.onOpen(thread)}
    >
      <View style={styles.rowLine}>
        <Text
          style={[styles.rowTitle, props.slim && styles.slimTitle]}
          numberOfLines={props.slim ? 1 : 2}
        >
          {props.pinned ? "• " : ""}
          {thread.title || "Untitled thread"}
        </Text>
        {chip ? (
          <View style={[styles.chipBadge, { borderColor: statusColors[chip.tone] }]}>
            <Text style={[styles.chipBadgeLabel, { color: statusColors[chip.tone] }]}>
              {chip.label}
            </Text>
          </View>
        ) : (
          <Text style={styles.time}>{props.timeLabel}</Text>
        )}
      </View>
      {failure !== null ? (
        <Text style={[styles.meta, { color: statusColors[chip!.tone] }]} numberOfLines={1}>
          {failure}
        </Text>
      ) : meta.length > 0 ? (
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
    </FocusablePressable>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  filters: { flexDirection: "row", gap: 20, marginBottom: 24 },
  chip: { paddingHorizontal: 28, paddingVertical: 14, maxWidth: 640 },
  chipActive: { borderColor: colors.accent },
  chipLabel: { color: colors.text, fontSize: 26, fontWeight: "600" },
  list: { flex: 1 },
  listContent: { gap: 12, paddingBottom: 64, paddingHorizontal: 8, paddingTop: 8 },
  sectionTitle: { color: colors.text, fontSize: 30, fontWeight: "700" },
  shelfHeader: {
    alignSelf: "flex-start",
    backgroundColor: "transparent",
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginTop: 16,
  },
  row: { paddingHorizontal: 28, paddingVertical: 18, gap: 6 },
  slimRow: { paddingVertical: 12, opacity: 0.8 },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 24 },
  rowTitle: { flex: 1, color: colors.text, fontSize: 30, fontWeight: "500" },
  slimTitle: { color: colors.textMuted, fontWeight: "400" },
  chipBadge: { borderWidth: 2, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 4 },
  chipBadgeLabel: { fontSize: 22, fontWeight: "700" },
  time: { color: colors.textMuted, fontSize: 24, fontVariant: ["tabular-nums"] },
  meta: { color: colors.textMuted, fontSize: 24 },
  moreRow: { alignSelf: "flex-start", paddingHorizontal: 28, paddingVertical: 14 },
  moreLabel: { color: colors.text, fontSize: 26, fontWeight: "600" },
  muted: { color: colors.textMuted, fontSize: 26 },
});
