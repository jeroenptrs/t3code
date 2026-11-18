import { factoryRoleLabel } from "@t3tools/client-runtime/factories";
import { factorySaveInput } from "@t3tools/client-runtime/factories";
import {
  FACTORY_FOREMAN_ROLE,
  type FactoryIssue,
  type FactoryRole,
  type FactoryRoleName,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { ArrowLeftIcon, ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { FactoryFieldIssues, FactoryIssuesList } from "./FactoryIssues";
import { FACTORY_ROUTE, factoryRoleStatus, issuesFor } from "./FactoryPage.logic";
import type { FactoryTabProps } from "./FactoryPage";
import {
  FactoryConfirmDialog,
  FactorySaveActions,
  FactorySaveError,
  FactoryStatusDot,
  useFactoryEditable,
  useFactorySave,
  type FactorySaveRefusal,
} from "./FactoryPageParts";
import { FactoryBindingFields, useFactoryModelChoices } from "./FactoryRoleBinding";
import {
  removeRoleSaveInput,
  roleDraft,
  roleDraftChanged,
  roleFileChange,
  type RoleDraft,
} from "./FactoryRoles.logic";
import { ROLE_STATUS } from "./FactoryRolesTab";
import { SKILL_SOURCE_LABEL } from "./FactorySkills.logic";

/** Fields a card shows its issues beside; the rest list above the cards. */
const CARD_FIELDS = new Set([
  "model",
  "runtimeMode",
  "interactionMode",
  "isolation",
  "skills",
  "body",
]);

/** One role's file: its instructions, the skills it binds, and its bindings, saved together. */
export function FactoryRolePage(props: FactoryTabProps & { readonly role: FactoryRoleName }) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, factory } = props;
  const role = factory.roles.find((candidate) => candidate.role === props.role);
  const back = (
    <Button
      size="xs"
      variant="ghost-muted"
      className="self-start"
      render={
        <Link
          to={FACTORY_ROUTE}
          params={{ environmentId, factoryId: factory.id }}
          search={{ tab: "roles" }}
        />
      }
    >
      <ArrowLeftIcon />
      {gt("Roles", { $context: "factory page tab" })}
    </Button>
  );
  if (role === undefined) {
    return (
      <>
        {back}
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>
              {gt("This factory has no role named {role}.", {
                role: factoryRoleLabel(props.role, messages),
              })}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      </>
    );
  }
  return <RoleEditor {...props} role={role} back={back} />;
}

function RoleEditor(
  props: Omit<FactoryTabProps, "search"> & {
    readonly role: FactoryRole;
    readonly back: ReactNode;
  },
) {
  const gt = useGT();
  const messages = useMessages();
  const id = useId();
  const navigate = useNavigate({ from: FACTORY_ROUTE });
  const { environmentId, factory, role } = props;
  const { editable, blockedReason } = useFactoryEditable(environmentId, factory, props.canManage);
  const models = useFactoryModelChoices(environmentId, factory);
  const { saving, save } = useFactorySave(environmentId);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [refusal, setRefusal] = useState<FactorySaveRefusal | null>(null);
  const [removing, setRemoving] = useState(false);
  const shown = draft ?? roleDraft(role);
  const dirty = draft !== null && roleDraftChanged(role, draft);
  const label = factoryRoleLabel(role.role, messages);
  const status = ROLE_STATUS[factoryRoleStatus(role, factory.issues)];
  const issues: ReadonlyArray<FactoryIssue> = [...factory.issues, ...(refusal?.issues ?? [])];
  const pageIssues = issuesFor(factory.issues, role.role).filter(
    (issue) => issue.field === null || !CARD_FIELDS.has(issue.field),
  );
  const edit = (change: (current: RoleDraft) => RoleDraft) =>
    setDraft((current) => change(current ?? roleDraft(role)));
  const skillByName = new Map(factory.skills.map((skill) => [skill.name, skill] as const));
  const addable = factory.skills.filter((skill) => !shown.skills.includes(skill.name));
  const disabled = !editable || saving;

  const submit = async () => {
    if (draft === null) return;
    setRefusal(null);
    const result = await save(factorySaveInput(factory, { roles: [roleFileChange(role, draft)] }));
    if ("refusal" in result) {
      setRefusal(result.refusal);
      return;
    }
    props.onSaved(result.saved);
    setDraft(null);
    toastManager.add({ type: "success", title: gt("Role saved") });
  };

  return (
    <>
      {props.back}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FactoryStatusDot tone={status.tone} label={messages(status.label)} />
          <h2 className="truncate text-base font-semibold">{label}</h2>
        </div>
        {editable ? (
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
        ) : null}
      </div>
      <FactorySaveError refusal={refusal} />
      <FactoryIssuesList issues={pageIssues} />

      <SettingsSection title={gt("Instructions")}>
        <div className="flex flex-col gap-2 p-3 sm:p-4">
          {editable ? (
            <Textarea
              id={`${id}-body`}
              aria-label={gt("Instructions")}
              className="max-h-[60vh] overflow-y-auto"
              rows={12}
              value={shown.body}
              placeholder={gt("Blank keeps the preset's instructions, or none for a new role.")}
              disabled={disabled}
              onChange={(event) => {
                const body = event.target.value;
                edit((current) => ({ ...current, body }));
              }}
            />
          ) : (
            <pre className="max-h-[60vh] overflow-y-auto font-mono text-xs whitespace-pre-wrap">
              {role.body}
            </pre>
          )}
          <FactoryFieldIssues issues={issuesFor(issues, role.role, "body")} />
        </div>
      </SettingsSection>

      <SettingsSection
        title={gt("Skills")}
        headerAction={
          editable ? (
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="ghost-muted" disabled={disabled} />}>
                <PlusIcon className="size-3" />
                <T>Add skill</T>
                <ChevronDownIcon className="size-3" />
              </MenuTrigger>
              <MenuPopup align="end" className="max-h-80">
                {addable.length === 0 ? (
                  <MenuItem disabled>
                    <T>Every skill is bound</T>
                  </MenuItem>
                ) : (
                  addable.map((skill) => (
                    <MenuItem
                      key={skill.name}
                      onClick={() =>
                        edit((current) => ({ ...current, skills: [...current.skills, skill.name] }))
                      }
                    >
                      <span className="flex-1">{skill.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {messages(SKILL_SOURCE_LABEL[skill.source])}
                      </span>
                    </MenuItem>
                  ))
                )}
              </MenuPopup>
            </Menu>
          ) : null
        }
      >
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          <T>Used as written. Edit in Skills.</T>
        </p>
        {shown.skills.map((name) => {
          const skill = skillByName.get(name);
          return (
            <div key={name} className="flex min-w-0 items-center gap-3 px-3 py-2.5 sm:px-4">
              <Link
                to={FACTORY_ROUTE}
                params={{ environmentId, factoryId: factory.id }}
                search={{ tab: "skills" }}
                className="min-w-0 truncate text-sm font-medium underline-offset-2 hover:underline"
              >
                {name}
              </Link>
              {skill === undefined ? (
                <span className="text-xs text-warning-foreground">
                  <T>Not found</T>
                </span>
              ) : (
                <Badge variant="outline">{messages(SKILL_SOURCE_LABEL[skill.source])}</Badge>
              )}
              {editable ? (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  className="ms-auto"
                  disabled={disabled}
                  aria-label={gt("Remove {skill}", { skill: name })}
                  onClick={() =>
                    edit((current) => ({
                      ...current,
                      skills: current.skills.filter((candidate) => candidate !== name),
                    }))
                  }
                >
                  <XIcon />
                </Button>
              ) : null}
            </div>
          );
        })}
        {issuesFor(issues, role.role, "skills").length === 0 ? null : (
          <div className="px-3 py-2.5 sm:px-4">
            <FactoryFieldIssues issues={issuesFor(issues, role.role, "skills")} />
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={gt("Binding", { $context: "a role's model and modes" })}>
        <div className="p-3 sm:p-4">
          <FactoryBindingFields
            environmentId={environmentId}
            role={role.role}
            effective={role.binding}
            binding={shown.binding}
            editable={editable}
            disabled={disabled}
            issues={issues}
            models={models}
            onChange={(binding) => edit((current) => ({ ...current, binding }))}
          />
        </div>
      </SettingsSection>

      {editable && role.role !== FACTORY_FOREMAN_ROLE ? (
        <SettingsSection title={gt("Danger zone")}>
          <SettingsRow
            title={gt("Remove role")}
            description={gt("Takes the role out of this factory and deletes its file.")}
            control={
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={saving || blockedReason !== null}
                onClick={() => setRemoving(true)}
              >
                {gt("Remove role")}
              </Button>
            }
          />
          <FactoryConfirmDialog
            open={removing}
            title={gt("Remove {role}?", { role: label })}
            description={gt(
              "The Foreman can no longer route work to it, and its file is deleted. This cannot be undone.",
            )}
            confirmLabel={gt("Remove role")}
            onClose={() => setRemoving(false)}
            onConfirm={async () => {
              const result = await save(removeRoleSaveInput(factory, role.role));
              if ("refusal" in result) return result.refusal.message;
              props.onSaved(result.saved);
              toastManager.add({ type: "success", title: gt("Role removed") });
              void navigate({ search: { tab: "roles" } });
              return null;
            }}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}
