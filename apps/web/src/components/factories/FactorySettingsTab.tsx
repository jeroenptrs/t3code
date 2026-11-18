import { useAtomValue } from "@effect/atom-react";
import { FACTORY_FOREMAN_ROLE, type FactoryRole } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { factoriesEnvironment } from "../../state/factories";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { InlineButton } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { DeleteFactoryDialog } from "./DeleteFactoryDialog";
import { FactoryFieldIssues, FactoryIssuesList } from "./FactoryIssues";
import { issueTab, issuesFor } from "./FactoryPage.logic";
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
  factorySaveInput,
  roleDraft,
  roleDraftChanged,
  roleFileChange,
  type RoleBindingDraft,
} from "./FactoryRoles.logic";

const toggled = <T,>(list: ReadonlyArray<T>, value: T, checked: boolean): ReadonlyArray<T> =>
  checked
    ? [...list.filter((entry) => entry !== value), value]
    : list.filter((entry) => entry !== value);

/** `definition.projects`: the other projects the factory may work in, saved to factory.json. */
function ProjectsCard(props: FactoryTabProps) {
  const gt = useGT();
  const { environmentId, factory } = props;
  const { editable, blockedReason } = useFactoryEditable(environmentId, factory, props.canManage);
  const { saving, save } = useFactorySave(environmentId);
  const [draft, setDraft] = useState<ReadonlyArray<string> | null>(null);
  const [refusal, setRefusal] = useState<FactorySaveRefusal | null>(null);
  const projects = draft ?? factory.definition.projects;
  const dirty = draft !== null && draft.join("\n") !== factory.definition.projects.join("\n");
  const here = useProjects().filter((project) => project.environmentId === environmentId);
  const titleCounts = new Map<string, number>();
  for (const project of here)
    titleCounts.set(project.title, (titleCounts.get(project.title) ?? 0) + 1);
  // The owning project is implied, so it is not offered.
  const choices = [
    ...new Set([
      ...here
        .filter((project) => project.id !== factory.projectId && project.archivedAt == null)
        .map((project) => project.title)
        .toSorted((left, right) => left.localeCompare(right)),
      ...projects,
    ]),
  ];
  const problem = (name: string) => {
    const count = titleCounts.get(name) ?? 0;
    if (count === 1) return null;
    return count === 0 ? gt("Not found here") : gt("More than one project has this name");
  };

  const submit = async () => {
    if (draft === null) return;
    setRefusal(null);
    const result = await save(factorySaveInput(factory, { definition: { projects: draft } }));
    if ("refusal" in result) {
      setRefusal(result.refusal);
      return;
    }
    props.onSaved(result.saved);
    setDraft(null);
    toastManager.add({ type: "success", title: gt("Projects saved") });
  };

  return (
    <SettingsSection
      title={gt("Projects")}
      headerAction={
        editable ? (
          <FactorySaveActions
            dirty={dirty}
            saving={saving}
            disabledReason={blockedReason}
            onDiscard={() => {
              setDraft(null);
              setRefusal(null);
            }}
            onSave={() => void submit()}
          />
        ) : null
      }
    >
      <SettingsRow
        title={gt("Other projects")}
        description={gt("The factory always works in its own project.")}
        control={
          editable ? (
            <Menu>
              <MenuTrigger
                render={<InlineButton tone="picker" disabled={saving} />}
                aria-label={gt("Choose projects")}
              >
                {projects.length === 0
                  ? gt("None", { $context: "no other projects" })
                  : gt("{count, plural, =1 {One project} other {{count} projects}}", {
                      count: projects.length,
                    })}
                <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </MenuTrigger>
              <MenuPopup align="end" className="max-h-80">
                {choices.length === 0 ? (
                  <MenuItem disabled>
                    <T>No other projects here</T>
                  </MenuItem>
                ) : null}
                {choices.map((name) => (
                  <MenuCheckboxItem
                    key={name}
                    checked={projects.includes(name)}
                    closeOnClick={false}
                    onCheckedChange={(checked) => setDraft(toggled(projects, name, checked))}
                  >
                    {name}
                  </MenuCheckboxItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null
        }
      />
      {projects.map((name) => (
        <SettingsRow key={name} title={name} status={problem(name)} />
      ))}
      {refusal === null && issuesFor(factory.issues, null, "projects").length === 0 ? null : (
        <div className="px-3 py-3 sm:px-4">
          <FactorySaveError refusal={refusal} />
          <FactoryFieldIssues
            issues={issuesFor([...factory.issues, ...(refusal?.issues ?? [])], null, "projects")}
          />
        </div>
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
  const fileIssues = factory.issues.filter(
    (issue) => issueTab(issue) === "settings" && issue.field !== "projects",
  );
  return (
    <>
      <FactoryIssuesList issues={fileIssues} />
      <ProjectsCard {...props} />
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
