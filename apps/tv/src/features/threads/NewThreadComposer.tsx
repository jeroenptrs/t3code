import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { TvTextInput } from "../../components/TvTextInput";
import { colors, conversation, typography } from "../../components/theme";
import type { ThreadRef } from "../../navigation/stack";
import {
  environmentProjects,
  environmentSummaries,
  serverEnvironment,
} from "../../state/environments";
import { useDevSendMessage } from "./devOpenThread";
import { resolveNewThreadDefaults, startNewThread } from "./newThread";
import { useEnvironmentScope } from "./vcs";

export interface ProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const projectKey = (ref: { readonly environmentId: EnvironmentId; readonly id: ProjectId }) =>
  `${ref.environmentId}:${ref.id}`;

/**
 * Mobile's new task, for the TV: pick a project, see the model it starts with, write the first
 * message, and Start. The thread runs in the project's checkout; worktrees and model choice stay
 * on web, desktop, and mobile.
 */
export function NewThreadComposer(props: {
  readonly defaultProject: ProjectRef | null;
  readonly environmentFilter: EnvironmentId | null;
  readonly onStarted: (thread: ThreadRef) => void;
}) {
  const allProjects = useAtomValue(environmentProjects.projectsAtom);
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  const projects = allProjects.filter(
    (project) =>
      props.environmentFilter === null || project.environmentId === props.environmentFilter,
  );
  const [pickedKey, setPickedKey] = useState<string | null>(() =>
    props.defaultProject
      ? projectKey({
          environmentId: props.defaultProject.environmentId,
          id: props.defaultProject.projectId,
        })
      : null,
  );
  // Without a pick, the first project whose environment can take the thread now.
  const project =
    projects.find((candidate) => projectKey(candidate) === pickedKey) ??
    projects.find((candidate) =>
      environments.some(
        (entry) =>
          entry.environmentId === candidate.environmentId && entry.connectionState === "connected",
      ),
    ) ??
    projects[0] ??
    null;
  const [text, setText] = useState("");
  const showEnvironment = props.environmentFilter === null && environments.length > 1;
  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((entry) => entry.environmentId === environmentId)?.environmentLabel ?? "";

  return (
    <View style={styles.root}>
      <Text style={styles.title}>New thread</Text>
      <Text style={styles.section}>Project</Text>
      {projects.length === 0 ? (
        <Text style={styles.muted}>No projects. Add one from web, desktop, or mobile.</Text>
      ) : (
        <ScrollView style={styles.projects} contentContainerStyle={styles.projectsContent}>
          {projects.map((candidate) => {
            const key = projectKey(candidate);
            const selected = project !== null && key === projectKey(project);
            return (
              <FocusablePressable
                key={key}
                style={[styles.projectRow, selected && styles.projectRowSelected]}
                hasTVPreferredFocus={selected}
                onPress={() => setPickedKey(key)}
              >
                <Text style={styles.projectTitle} numberOfLines={1}>
                  {selected ? "● " : ""}
                  {candidate.title}
                </Text>
                <Text style={styles.projectMeta} numberOfLines={1}>
                  {[
                    showEnvironment ? environmentLabel(candidate.environmentId) : "",
                    candidate.workspaceRoot,
                  ]
                    .filter(Boolean)
                    .join("  ·  ")}
                </Text>
              </FocusablePressable>
            );
          })}
        </ScrollView>
      )}
      {project !== null ? (
        <NewThreadForm
          key={projectKey(project)}
          project={project}
          text={text}
          onChangeText={setText}
          onStarted={props.onStarted}
        />
      ) : null}
    </View>
  );
}

function NewThreadForm(props: {
  readonly project: EnvironmentProject;
  readonly text: string;
  readonly onChangeText: (text: string) => void;
  readonly onStarted: (thread: ThreadRef) => void;
}) {
  const { project, onStarted } = props;
  const config = useAtomValue(serverEnvironment.configValueAtom(project.environmentId));
  const canOperate = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const environment = useAtomValue(environmentSummaries.environmentsAtom).find(
    (entry) => entry.environmentId === project.environmentId,
  );
  const defaults = resolveNewThreadDefaults(config ?? null, project);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const { modelSelection, runtimeMode } = defaults;
  const providers = config?.providers;
  const blockReason =
    environment?.connectionState !== "connected"
      ? `Waiting for ${environment?.environmentLabel ?? "the environment"} to connect.`
      : !canOperate
        ? "This connection cannot control this task. You can still edit your draft."
        : modelSelection === null
          ? "No model is available. Set up a provider on web or desktop."
          : null;
  const ready = blockReason === null && modelSelection !== null && providers !== undefined;

  const start = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!ready || trimmed.length === 0 || inFlight.current) return false;
      inFlight.current = true;
      setStarting(true);
      setError(null);
      const result = await startNewThread({
        project,
        text: trimmed,
        modelSelection,
        runtimeMode,
        providers,
      });
      inFlight.current = false;
      setStarting(false);
      if ("error" in result) {
        setError(result.error);
        return false;
      }
      onStarted({ environmentId: project.environmentId, threadId: result.threadId });
      return true;
    },
    [modelSelection, onStarted, project, providers, ready, runtimeMode],
  );
  useDevSendMessage(ready, start);

  const canStart = ready && !starting && props.text.trim().length > 0;
  return (
    <View style={styles.form}>
      <Text style={styles.section}>Model</Text>
      <FocusablePressable style={styles.modelRow} disabled>
        <Text style={styles.modelLabel} numberOfLines={1}>
          {defaults.modelLabel ?? "No model available"}
        </Text>
      </FocusablePressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {blockReason ? <Text style={styles.muted}>{blockReason}</Text> : null}
      <View style={styles.composer}>
        <View style={styles.inputColumn}>
          <TvTextInput
            value={props.text}
            onChangeText={props.onChangeText}
            placeholder="What should the agent do? (select to type or dictate)"
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
          />
        </View>
        <FocusablePressable
          style={styles.startButton}
          focusedStyle={styles.startButtonFocused}
          disabled={!canStart}
          onPress={() => void start(props.text)}
        >
          <Text style={styles.startLabel}>{starting ? "Starting…" : "Start"}</Text>
        </FocusablePressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, width: "100%", maxWidth: 1200, alignSelf: "center", paddingTop: 48, gap: 12 },
  title: { color: colors.text, fontSize: 44, fontWeight: "700", marginBottom: 12 },
  section: { color: colors.textMuted, ...typography.small, marginTop: 8 },
  muted: { color: colors.textMuted, ...typography.small },
  error: { color: colors.danger, ...typography.small },
  projects: { flexGrow: 0, maxHeight: 420 },
  projectsContent: { gap: 8, paddingVertical: 4 },
  projectRow: { paddingHorizontal: 24, paddingVertical: 14, gap: 4 },
  projectRowSelected: { backgroundColor: colors.selected },
  projectTitle: { color: colors.text, ...typography.body, fontWeight: "600" },
  projectMeta: { color: colors.textMuted, ...typography.small },
  form: { gap: 12 },
  modelRow: { paddingHorizontal: 24, paddingVertical: 14 },
  modelLabel: { color: colors.text, ...typography.body },
  // Static on purpose: TvTextInput's parents must not change style with focus.
  composer: {
    ...conversation.composer,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    borderWidth: 2,
    borderRadius: 36,
    padding: 10,
    marginTop: 16,
  },
  inputColumn: { flex: 1 },
  startButton: {
    paddingHorizontal: 40,
    paddingVertical: 18,
    borderRadius: 28,
    backgroundColor: colors.accent,
  },
  startButtonFocused: { backgroundColor: colors.accent, borderColor: colors.text },
  startLabel: { color: colors.text, fontSize: 30, fontWeight: "700" },
});
