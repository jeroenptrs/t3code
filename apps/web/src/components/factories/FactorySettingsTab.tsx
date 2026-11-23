import { factorySaveInput } from "@t3tools/client-runtime/factories";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useAtomValue } from "@effect/atom-react";
import { FACTORY_FOREMAN_ROLE, type FactoryRole } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { factoriesEnvironment } from "../../state/factories";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { toastManager } from "../ui/toast";
import { DeleteFactoryDialog } from "./DeleteFactoryDialog";
import { FactoryIssuesList } from "./FactoryIssues";
import { issueTab } from "./FactoryPage.logic";
import type { FactoryTabProps } from "./FactoryPage";
import {
  FactorySaveActions,
  FactorySaveError,
  useFactoryEditable,
  useFactorySave,
  type FactorySaveRefusal,
} from "./FactoryPageParts";
import { FactoryBindingFields, useFactoryModelChoices } from "./FactoryRoleBinding";
import {
  roleDraft,
  roleDraftChanged,
  roleFileChange,
  type RoleBindingDraft,
} from "./FactoryRoles.logic";

/** What the factory's project covers, read-only: the project's Repositories settings change it. */
function RepositoriesCard(props: FactoryTabProps) {
  const gt = useGT();
  const { environmentId, factory } = props;
  const settings = useEnvironmentSettings(environmentId);
  const project = useProjects().find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === factory.projectId,
  );
  const projectKey =
    project === undefined
      ? null
      : deriveLogicalProjectKeyFromSettings(project, selectProjectGroupingSettings(settings));
  return (
    <SettingsSection
      title={gt("Repositories")}
      headerAction={
        projectKey === null ? null : (
          <Link
            to="/settings/projects"
            search={{ project: projectKey, machine: undefined }}
            hash="project-repositories"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            <T>Edit in project settings</T>
          </Link>
        )
      }
    >
      {factory.repositories.length === 0 ? (
        <SettingsRow
          title={gt("No repositories")}
          description={gt("Add a folder in the project's Repositories settings.")}
        />
      ) : (
        factory.repositories.map((repository) => (
          <SettingsRow
            key={repository.path}
            title={repository.name}
            description={repository.path}
          />
        ))
      )}
    </SettingsSection>
  );
}

/** The Foreman's model and where it works, saved to its role file like its role page does. */
function ForemanCard(props: FactoryTabProps & { readonly foreman: FactoryRole }) {
  const gt = useGT();
  const { environmentId, factory, foreman } = props;
  const { editable, blockedReason } = useFactoryEditable(environmentId, factory, props.canManage);
  const models = useFactoryModelChoices(environmentId, factory);
  const { saving, save } = useFactorySave(environmentId);
  const [binding, setBinding] = useState<RoleBindingDraft | null>(null);
  const [refusal, setRefusal] = useState<FactorySaveRefusal | null>(null);
  const draft = binding === null ? null : { ...roleDraft(foreman), binding };
  const dirty = draft !== null && roleDraftChanged(foreman, draft);

  const submit = async () => {
    if (draft === null) return;
    setRefusal(null);
    const result = await save(
      factorySaveInput(factory, { roles: [roleFileChange(foreman, draft)] }),
    );
    if ("refusal" in result) {
      setRefusal(result.refusal);
      return;
    }
    props.onSaved(result.saved);
    setBinding(null);
    toastManager.add({ type: "success", title: gt("Foreman saved") });
  };

  return (
    <SettingsSection
      title={gt("Foreman", { $context: "factory role that routes work" })}
      headerAction={
        editable ? (
          <FactorySaveActions
            dirty={dirty}
            saving={saving}
            disabledReason={blockedReason}
            onDiscard={() => {
              setBinding(null);
              setRefusal(null);
            }}
            onSave={() => void submit()}
          />
        ) : null
      }
    >
      <div className="flex flex-col gap-3 p-3 sm:p-4">
        <FactorySaveError refusal={refusal} />
        <FactoryBindingFields
          environmentId={environmentId}
          role={FACTORY_FOREMAN_ROLE}
          effective={foreman.binding}
          binding={binding ?? roleDraft(foreman).binding}
          fields={["model", "isolation"]}
          editable={editable}
          disabled={saving}
          issues={[...factory.issues, ...(refusal?.issues ?? [])]}
          models={models}
          onChange={setBinding}
        />
      </div>
    </SettingsSection>
  );
}

export function FactorySettingsTab(props: FactoryTabProps) {
  const gt = useGT();
  const { environmentId, factory } = props;
  const canDelete =
    useAtomValue(factoriesEnvironment.delete.permissionAtom(environmentId)) && props.canManage;
  const foreman = factory.roles.find((role) => role.role === FACTORY_FOREMAN_ROLE);
  const fileIssues = factory.issues.filter((issue) => issueTab(issue) === "settings");
  return (
    <>
      <FactoryIssuesList issues={fileIssues} />
      <RepositoriesCard {...props} />
      {foreman === undefined ? null : <ForemanCard {...props} foreman={foreman} />}
      {canDelete ? (
        <SettingsSection title={gt("Danger zone")}>
          <SettingsRow
            title={gt("Delete factory")}
            description={gt(
              "Removes its folder with its roles and skills, and drops its work items.",
            )}
            control={
              <DeleteFactoryDialog
                environmentId={environmentId}
                factory={factory}
                disabled={false}
              />
            }
          />
        </SettingsSection>
      ) : null}
    </>
  );
}
