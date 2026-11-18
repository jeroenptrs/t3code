import { factoryRoleLabel } from "@t3tools/client-runtime/factories";
import { factorySaveInput, roleEnabledChange } from "@t3tools/client-runtime/factories";
import {
  FACTORY_FOREMAN_ROLE,
  type EnvironmentId,
  type Factory,
  type FactoryRole,
  type FactoryRoleName,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  FACTORY_ROUTE,
  factoryRoleStatus,
  issuesFor,
  type FactoryRoleStatus,
} from "./FactoryPage.logic";
import type { FactoryTabProps } from "./FactoryPage";
import {
  FactoryIssueCount,
  FactoryRowLink,
  ROW_LINK_CLASS,
  FactorySaveError,
  FactoryStatusDot,
  useFactoryEditable,
  useFactorySave,
  type FactorySaveRefusal,
  type StatusTone,
} from "./FactoryPageParts";
import {
  factoryModelLabel,
  useFactoryModelChoices,
  type FactoryModelChoices,
} from "./FactoryRoleBinding";
import {
  addRoleSaveInput,
  roleNameError,
  type RoleNameError,
  type RoleStart,
} from "./FactoryRoles.logic";

export const ROLE_STATUS: Record<FactoryRoleStatus, { readonly tone: StatusTone; label: string }> =
  {
    issues: { tone: "destructive", label: msg("This role has problems") },
    disabled: { tone: "muted", label: msg("Off", { $context: "a disabled factory role" }) },
    enabled: { tone: "success", label: msg("On", { $context: "an enabled factory role" }) },
  };

function RoleRow(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly role: FactoryRole;
  readonly models: FactoryModelChoices;
  readonly editable: boolean;
  readonly blocked: boolean;
  readonly onToggle: (role: FactoryRole, enabled: boolean) => void;
  readonly busy: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { role, models } = props;
  const status = ROLE_STATUS[factoryRoleStatus(role, props.factory.issues)];
  const label = factoryRoleLabel(role.role, messages);
  const issueCount = issuesFor(props.factory.issues, role.role).length;
  return (
    <FactoryRowLink
      leading={
        <span className="relative z-10 flex">
          <FactoryStatusDot tone={status.tone} label={messages(status.label)} />
        </span>
      }
      title={label}
      meta={factoryModelLabel(role.binding.model, models.instanceEntries, messages)}
      trailing={
        <>
          <FactoryIssueCount count={issueCount} />
          {role.role === FACTORY_FOREMAN_ROLE || !props.editable ? null : (
            <Switch
              checked={role.enabled}
              disabled={props.busy || props.blocked}
              aria-label={gt("Enable {role}", { role: label })}
              onCheckedChange={(checked) => props.onToggle(role, checked)}
            />
          )}
        </>
      }
      link={
        <Link
          to={FACTORY_ROUTE}
          params={{ environmentId: props.environmentId, factoryId: props.factory.id }}
          search={{ tab: "roles", role: role.role }}
          className={ROW_LINK_CLASS}
          aria-label={label}
        />
      }
    />
  );
}

export function FactoryRolesTab(props: FactoryTabProps) {
  const gt = useGT();
  const { environmentId, factory } = props;
  const { editable, blockedReason } = useFactoryEditable(environmentId, factory, props.canManage);
  const { saving, save } = useFactorySave(environmentId);
  const models = useFactoryModelChoices(environmentId, factory);
  const [adding, setAdding] = useState(false);

  const toggle = async (role: FactoryRole, enabled: boolean) => {
    const result = await save(
      factorySaveInput(factory, { roles: [roleEnabledChange(role, enabled)] }),
    );
    if ("refusal" in result) {
      toastManager.add({
        type: "error",
        title: enabled ? gt("Could not turn the role on") : gt("Could not turn the role off"),
        description: result.refusal.message,
      });
      return;
    }
    props.onSaved(result.saved);
  };

  return (
    <>
      <SettingsSection
        title={gt("Roles")}
        headerAction={
          editable ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={blockedReason !== null}
              title={blockedReason ?? undefined}
              onClick={() => setAdding(true)}
            >
              <PlusIcon className="size-3" />
              <T>Add role</T>
            </Button>
          ) : null
        }
      >
        {factory.roles.map((role) => (
          <RoleRow
            key={role.role}
            environmentId={environmentId}
            factory={factory}
            role={role}
            models={models}
            editable={editable}
            blocked={blockedReason !== null}
            busy={saving}
            onToggle={(next, enabled) => void toggle(next, enabled)}
          />
        ))}
      </SettingsSection>
      {adding ? (
        <AddRoleDialog
          environmentId={environmentId}
          factory={factory}
          onSaved={props.onSaved}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </>
  );
}

const SCRATCH = "scratch";

function AddRoleDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly onSaved: (factory: Factory) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const id = useId();
  const navigate = useNavigate({ from: FACTORY_ROUTE });
  const { saving, save } = useFactorySave(props.environmentId);
  const presets = props.factory.rolePresets.filter(
    (preset) => preset.name !== FACTORY_FOREMAN_ROLE,
  );
  const [name, setName] = useState("");
  const [start, setStart] = useState<string>(presets[0]?.name ?? SCRATCH);
  const [nameError, setNameError] = useState<RoleNameError | null>(null);
  const [refusal, setRefusal] = useState<FactorySaveRefusal | null>(null);
  const errorText: Record<RoleNameError, string> = {
    empty: gt("Enter a name."),
    too_long: gt("Use 64 characters or fewer."),
    pattern: gt("Use lowercase letters, digits, and single hyphens, such as triage."),
    reserved: gt("This name is a work item stage. Pick another."),
    taken: gt("This factory already has a role with this name."),
  };
  const startItems = [
    ...presets.map((preset) => ({
      value: preset.name,
      label: gt("Preset {role}", { role: factoryRoleLabel(preset.name, messages) }),
    })),
    { value: SCRATCH, label: gt("From scratch") },
  ];

  const submit = async () => {
    const error = roleNameError(name, props.factory);
    setNameError(error);
    if (error !== null || saving) return;
    const roleName = name.trim() as FactoryRoleName;
    const preset = presets.find((candidate) => candidate.name === start);
    const roleStart: RoleStart =
      preset === undefined ? { kind: "scratch" } : { kind: "preset", preset };
    setRefusal(null);
    const result = await save(addRoleSaveInput(props.factory, roleName, roleStart));
    if ("refusal" in result) {
      setRefusal(result.refusal);
      return;
    }
    props.onSaved(result.saved);
    props.onClose();
    toastManager.add({ type: "success", title: gt("Role added") });
    void navigate({ search: { tab: "roles", role: roleName } });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Add role</T>
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>{gt("Name", { $context: "role name" })}</Label>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={64}
                autoFocus
                autoComplete="off"
                aria-invalid={nameError !== null}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  if (name !== "") setNameError(roleNameError(name, props.factory));
                }}
              />
              {nameError === null ? (
                <p className="text-xs text-muted-foreground">
                  <T>Lowercase letters, digits, and hyphens.</T>
                </p>
              ) : (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {errorText[nameError]}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-start`}>{gt("Start from")}</Label>
              <Select
                value={start}
                items={startItems}
                onValueChange={(value) => {
                  if (value !== null) setStart(value);
                }}
              >
                <SelectTrigger id={`${id}-start`} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {startItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {start !== SCRATCH && name.trim() !== "" && name.trim() !== start ? (
                <p className="text-xs text-muted-foreground">
                  <T>The new role gets a copy of the preset's instructions and settings.</T>
                </p>
              ) : null}
            </div>
            <FactorySaveError refusal={refusal} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? gt("Adding…") : gt("Add role")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
