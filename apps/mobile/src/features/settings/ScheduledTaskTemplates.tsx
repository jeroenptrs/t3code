import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  fillTriggerTemplate,
  type EnvironmentId,
  type ProjectId,
  type TriggerTemplate,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { startScheduledTaskEditor } from "./scheduled-task-editor-state";
import { scheduledTaskDefaultModel } from "./scheduledTaskDraft";
import { TRIGGER_SOURCE_LABELS } from "./scheduledTaskPresentation";
import { scheduledTaskDraftFromTemplate } from "./scheduledTaskTemplate";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

type TemplateRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly templateName: string;
};

type TemplateRoutes = {
  SettingsScheduledTaskNew: undefined;
  SettingsScheduledTaskTemplate: TemplateRouteParams;
};

/** Opens the task editor with a draft made from the template, as the new-task flow does. */
function useStartTaskFromTemplate() {
  const navigation = useNavigation<NativeStackNavigationProp<TemplateRoutes>>();
  const configs = useServerConfigs();
  const projects = useProjects();
  const { availableTargets } = useSettingsEnvironmentFilter();
  return (
    params: TemplateRouteParams,
    template: TriggerTemplate,
    values: Readonly<Record<string, string>>,
    replace: boolean,
  ) => {
    const project = projects.find(
      (entry) => entry.environmentId === params.environmentId && entry.id === params.projectId,
    );
    const result = scheduledTaskDraftFromTemplate(template, values, {
      projectId: params.projectId,
      modelSelection: scheduledTaskDefaultModel(
        configs.get(params.environmentId) ?? null,
        project ?? null,
      ),
    });
    if ("error" in result) {
      Dialog.alert("Template is incomplete", result.error);
      return;
    }
    startScheduledTaskEditor({
      environmentId: params.environmentId,
      environmentLabel:
        availableTargets.find((target) => target.environmentId === params.environmentId)?.label ??
        "",
      draft: result.draft,
    });
    if (replace) navigation.replace("SettingsScheduledTaskNew");
    else navigation.navigate("SettingsScheduledTaskNew");
  };
}

function filterCountLabel(count: number): string {
  return `${count} filter${count === 1 ? "" : "s"}`;
}

/** Trigger templates of the listed projects, read-only; tapping one starts a task from it. */
export function ScheduledTaskTemplates({
  targets,
  projectSelected,
}: {
  readonly targets: ReadonlyArray<{
    readonly environment: SettingsTarget;
    readonly projectIds: readonly ProjectId[] | null;
  }>;
  /** With a project picked, its sections show even when empty. */
  readonly projectSelected: boolean;
}) {
  return targets.map(({ environment, projectIds }) => (
    <EnvironmentTemplates
      key={environment.environmentId}
      environment={environment}
      projectIds={projectIds}
      projectSelected={projectSelected}
      showEnvironment={targets.length > 1}
    />
  ));
}

function EnvironmentTemplates({
  environment,
  projectIds,
  projectSelected,
  showEnvironment,
}: {
  readonly environment: SettingsTarget;
  readonly projectIds: readonly ProjectId[] | null;
  readonly projectSelected: boolean;
  readonly showEnvironment: boolean;
}) {
  const canRead = useAtomValue(
    serverEnvironment.triggerTemplates.permissionAtom(environment.environmentId),
  );
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environment.environmentId &&
      (projectIds === null ? project.archivedAt == null : projectIds.includes(project.id)),
  );
  if (!canRead) return null;
  return projects.map((project) => (
    <ProjectTemplates
      key={project.id}
      environment={environment}
      project={project}
      showEmpty={projectSelected}
      showEnvironment={showEnvironment}
    />
  ));
}

function ProjectTemplates({
  environment,
  project,
  showEmpty,
  showEnvironment,
}: {
  readonly environment: SettingsTarget;
  readonly project: EnvironmentProject;
  readonly showEmpty: boolean;
  readonly showEnvironment: boolean;
}) {
  const environmentId = environment.environmentId;
  const navigation = useNavigation<NativeStackNavigationProp<TemplateRoutes>>();
  const startTask = useStartTaskFromTemplate();
  const query = useEnvironmentQuery(
    serverEnvironment.triggerTemplates({ environmentId, input: { projectId: project.id } }),
  );
  const templates = query.data?.templates;
  // Without a picked project, every project is listed, so only the ones with templates show.
  if (!showEmpty && !query.error && !templates?.length) return null;

  return (
    <SettingsSection
      title={`Trigger templates · ${project.title}${showEnvironment ? ` · ${environment.label}` : ""}`}
    >
      {query.error ? (
        <Text className="p-4 text-base text-danger-foreground">{query.error}</Text>
      ) : !templates ? (
        <Text className="p-4 text-base text-foreground-muted">Loading templates…</Text>
      ) : templates.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          No templates. Add them to the project's .t3/triggers folder.
        </Text>
      ) : (
        templates.map((template, index) => (
          <Pressable
            key={template.name}
            accessibilityRole="button"
            accessibilityLabel={`Use ${template.title}`}
            onPress={() => {
              const params = { environmentId, projectId: project.id, templateName: template.name };
              if (template.placeholders.length === 0) startTask(params, template, {}, false);
              else navigation.navigate("SettingsScheduledTaskTemplate", params);
            }}
            className={
              index === 0
                ? "gap-1 px-4 py-3 active:opacity-70"
                : "gap-1 border-t border-border-subtle px-4 py-3 active:opacity-70"
            }
          >
            <Text textRole="body" className="text-foreground" numberOfLines={1}>
              {template.title}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={1}>
              {TRIGGER_SOURCE_LABELS[template.source]} · {filterCountLabel(template.filters.length)}
            </Text>
          </Pressable>
        ))
      )}
    </SettingsSection>
  );
}

export function SettingsScheduledTaskTemplateRouteScreen({
  route,
}: StaticScreenProps<TemplateRouteParams>) {
  const params = route.params;
  const insets = useSafeAreaInsets();
  const query = useEnvironmentQuery(
    serverEnvironment.triggerTemplates({
      environmentId: params.environmentId,
      input: { projectId: params.projectId },
    }),
  );
  const template = query.data?.templates.find((entry) => entry.name === params.templateName);

  return (
    <SettingsScreen title={template?.title ?? "Use template"}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {template ? (
          <TemplateValuesForm key={template.name} params={params} template={template} />
        ) : (
          <Text
            className={
              query.error
                ? "px-2 text-base text-danger-foreground"
                : "px-2 text-base text-foreground-muted"
            }
          >
            {query.error ??
              (query.data ? "This template is no longer in the project." : "Loading template…")}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function TemplateValuesForm({
  params,
  template,
}: {
  readonly params: TemplateRouteParams;
  readonly template: TriggerTemplate;
}) {
  const startTask = useStartTaskFromTemplate();
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(params.environmentId),
  );
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(
      template.placeholders.map((placeholder) => [placeholder.name, placeholder.default ?? ""]),
    ),
  );
  const missing = fillTriggerTemplate(template, values).missing;

  return (
    <>
      <SettingsSection
        title="Values"
        footer={canCreate ? undefined : "This session can't create triggers."}
      >
        {template.placeholders.map((placeholder, index) => (
          <View
            key={placeholder.name}
            className={
              index === 0 ? "gap-2 px-4 py-3" : "gap-2 border-t border-border-subtle px-4 py-3"
            }
          >
            <Text className="text-sm text-foreground-muted">
              {placeholder.name}
              {placeholder.default === undefined ? " (required)" : ""}
            </Text>
            <RNTextInput
              accessibilityLabel={placeholder.name}
              value={values[placeholder.name] ?? ""}
              onChangeText={(value) =>
                setValues((current) => ({ ...current, [placeholder.name]: value }))
              }
              autoCapitalize="none"
              autoCorrect={false}
              textAlignVertical="center"
              placeholder={placeholder.default}
              placeholderTextColorClassName="accent-foreground-muted"
              className="min-h-8 font-sans text-base text-foreground"
            />
            {placeholder.description ? (
              <Text className="text-sm text-foreground-muted">{placeholder.description}</Text>
            ) : null}
          </View>
        ))}
      </SettingsSection>
      <Button
        label="Create task"
        tone="primary"
        fullWidth
        disabled={!canCreate || missing.length > 0}
        onPress={() => startTask(params, template, values, true)}
      />
    </>
  );
}
