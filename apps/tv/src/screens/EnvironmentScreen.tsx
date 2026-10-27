import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, TVFocusGuideView, View } from "react-native";

import { ConnectionBadge } from "../components/ConnectionBadge";
import { FocusablePressable } from "../components/FocusablePressable";
import { colors } from "../components/theme";
import {
  environmentProjects,
  environmentShell,
  environmentSummaries,
  environmentThreadShells,
} from "../state/environments";

const ALL_PROJECTS = "all" as const;

function threadStatusLabel(thread: OrchestrationV2ThreadShell): string {
  if (thread.pendingRuntimeRequest !== null) return "Needs input";
  if (thread.activityRunStatus) return thread.activityRunStatus;
  return thread.status === "idle" ? "" : thread.status;
}

export function EnvironmentScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly onBack: () => void;
}) {
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  const environment = environments.find((entry) => entry.environmentId === props.environmentId);
  // Reading the shell state subscribes to the environment's shell stream while this screen shows.
  const shell = useAtomValue(environmentShell.stateValueAtom(props.environmentId));
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(props.environmentId));
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(props.environmentId));
  const [selectedProject, setSelectedProject] = useState<ProjectId | typeof ALL_PROJECTS>(
    ALL_PROJECTS,
  );

  const projectTitles = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title] as const)),
    [projects],
  );
  const visibleThreads = useMemo(
    () =>
      // Hermes on tvOS has no Array.prototype.toSorted; filter returns a fresh array to sort.
      threads
        .filter(
          (thread) =>
            thread.archivedAt === null &&
            thread.deletedAt === null &&
            (selectedProject === ALL_PROJECTS || thread.projectId === selectedProject),
        )
        .sort(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        ),
    [selectedProject, threads],
  );

  const shellError = Option.getOrNull(shell.error);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <FocusablePressable style={styles.backButton} onPress={props.onBack}>
          <Text style={styles.buttonLabel}>‹ Environments</Text>
        </FocusablePressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>{environment?.environmentLabel ?? "Environment"}</Text>
          {environment ? <ConnectionBadge phase={environment.connectionState} /> : null}
        </View>
        <Text style={styles.muted}>
          {shell.status === "synchronizing" ? "Syncing…" : ""}
          {shellError ? ` ${shellError}` : ""}
        </Text>
      </View>
      <View style={styles.columns}>
        <TVFocusGuideView style={styles.projectColumn} autoFocus>
          <Text style={styles.sectionTitle}>Projects</Text>
          <FlatList
            data={
              [ALL_PROJECTS, ...projects] as ReadonlyArray<
                typeof ALL_PROJECTS | OrchestrationProjectShell
              >
            }
            keyExtractor={(item) => (item === ALL_PROJECTS ? ALL_PROJECTS : item.id)}
            contentContainerStyle={styles.listContent}
            renderItem={({ item, index }) => {
              const id = item === ALL_PROJECTS ? ALL_PROJECTS : item.id;
              const selected = id === selectedProject;
              return (
                <FocusablePressable
                  style={[styles.projectRow, selected && styles.selectedRow]}
                  hasTVPreferredFocus={index === 0}
                  onFocus={() => setSelectedProject(id)}
                >
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item === ALL_PROJECTS ? "All projects" : item.title}
                  </Text>
                  {item === ALL_PROJECTS ? null : (
                    <Text style={styles.muted} numberOfLines={1}>
                      {item.workspaceRoot}
                    </Text>
                  )}
                </FocusablePressable>
              );
            }}
          />
        </TVFocusGuideView>
        <TVFocusGuideView style={styles.threadColumn} autoFocus>
          <Text style={styles.sectionTitle}>Threads ({visibleThreads.length})</Text>
          {visibleThreads.length === 0 ? (
            <Text style={styles.muted}>
              {shell.status === "synchronizing" ? "Loading threads…" : "No threads."}
            </Text>
          ) : (
            <FlatList
              data={visibleThreads}
              keyExtractor={(thread) => thread.id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item: thread }) => (
                <FocusablePressable style={styles.threadRow}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {thread.title || "Untitled thread"}
                  </Text>
                  <View style={styles.threadMeta}>
                    <Text style={styles.muted} numberOfLines={1}>
                      {projectTitles.get(thread.projectId) ?? ""}
                      {thread.branch ? ` · ${thread.branch}` : ""}
                    </Text>
                    <Text style={styles.status}>{threadStatusLabel(thread)}</Text>
                  </View>
                </FocusablePressable>
              )}
            />
          )}
        </TVFocusGuideView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 96, paddingTop: 56 },
  header: { flexDirection: "row", alignItems: "center", gap: 40, marginBottom: 32 },
  headerText: { gap: 8 },
  backButton: { paddingHorizontal: 28, paddingVertical: 16 },
  title: { color: colors.text, fontSize: 52, fontWeight: "700" },
  columns: { flex: 1, flexDirection: "row", gap: 48 },
  projectColumn: { width: 560 },
  threadColumn: { flex: 1 },
  sectionTitle: { color: colors.text, fontSize: 34, fontWeight: "600", marginBottom: 16 },
  listContent: { gap: 14, paddingBottom: 64, paddingHorizontal: 8, paddingTop: 8 },
  projectRow: { paddingHorizontal: 24, paddingVertical: 18, gap: 4 },
  selectedRow: { borderColor: colors.surfaceFocused },
  threadRow: { paddingHorizontal: 28, paddingVertical: 20, gap: 6 },
  threadMeta: { flexDirection: "row", justifyContent: "space-between", gap: 24 },
  rowTitle: { color: colors.text, fontSize: 30, fontWeight: "500" },
  buttonLabel: { color: colors.text, fontSize: 28, fontWeight: "600" },
  muted: { color: colors.textMuted, fontSize: 24, flexShrink: 1 },
  status: { color: colors.warning, fontSize: 24 },
});
