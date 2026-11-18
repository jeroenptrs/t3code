/**
 * Fork-only. The skills a factory's roles can bind, each from the highest level that has it: the
 * factory's own, T3 home's, or the built-in one. Administrators create, edit, and delete the
 * factory and home levels here.
 */
import { factoryRoleLabel } from "@t3tools/client-runtime/factories";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FactorySkillError,
  FactorySkillName,
  type EnvironmentId,
  type Factory,
  type FactorySkill,
  type FactorySkillLevel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { factoriesEnvironment } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import type { FactoryTabProps } from "./FactoryPage";
import { FactoryConfirmDialog, FactoryRowLink, ROW_LINK_CLASS } from "./FactoryPageParts";
import { skillUsers } from "./FactoryRoles.logic";
import {
  SKILL_SOURCE_LABEL,
  skillDeleteMessage,
  skillSaveLevels,
  skillTemplate,
  withSkillName,
} from "./FactorySkills.logic";

const isSkillName = Schema.is(FactorySkillName);
const isSkillError = Schema.is(FactorySkillError);

const LEVEL_DESCRIPTION: Readonly<Record<FactorySkillLevel, string>> = {
  factory: msg("Only this factory's roles see it."),
  home: msg("Every project on this server sees it, unless a factory has its own."),
};

/** Which sheet is open: a new skill, or one the list shows. */
type SkillSheet =
  | { readonly kind: "new" }
  | { readonly kind: "edit"; readonly skill: FactorySkill };

export function FactorySkillsTab(props: FactoryTabProps) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, factory } = props;
  const canWrite =
    useAtomValue(factoriesEnvironment.saveSkill.permissionAtom(environmentId)) && props.canManage;
  const [sheet, setSheet] = useState<SkillSheet | null>(null);

  return (
    <>
      <SettingsSection
        title={gt("Skills")}
        headerAction={
          canWrite ? (
            <Button size="xs" variant="ghost-muted" onClick={() => setSheet({ kind: "new" })}>
              <PlusIcon className="size-3" />
              <T>New skill</T>
            </Button>
          ) : null
        }
      >
        {factory.skills.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            <T>No skills yet. A new skill is a SKILL.md roles can bind.</T>
          </p>
        ) : (
          factory.skills.map((skill) => {
            const users = skillUsers(factory, skill.name).map((role) =>
              factoryRoleLabel(role, messages),
            );
            return (
              <FactoryRowLink
                key={skill.name}
                title={skill.name}
                meta={skill.description === "" ? undefined : skill.description}
                trailing={
                  <>
                    {users.length === 0 ? null : (
                      <span className="max-w-48 truncate text-xs text-muted-foreground">
                        {gt("Used by {roles}", { roles: users.join(", ") })}
                      </span>
                    )}
                    <Badge variant="outline">{messages(SKILL_SOURCE_LABEL[skill.source])}</Badge>
                  </>
                }
                link={
                  <button
                    type="button"
                    className={ROW_LINK_CLASS}
                    aria-label={skill.name}
                    onClick={() => setSheet({ kind: "edit", skill })}
                  />
                }
              />
            );
          })
        )}
      </SettingsSection>
      <Sheet
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      >
        <SheetPopup side="right" className="sm:max-w-2xl">
          {sheet === null ? null : (
            <SkillEditor
              key={sheet.kind === "new" ? "new" : `${sheet.skill.source}:${sheet.skill.name}`}
              environmentId={environmentId}
              factory={factory}
              skill={sheet.kind === "new" ? null : sheet.skill}
              canWrite={canWrite}
              onClose={() => setSheet(null)}
            />
          )}
        </SheetPopup>
      </Sheet>
    </>
  );
}

/** Creates a skill, or saves an edit of one at the level the person picks. */
function SkillEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  /** Null for a new skill. */
  readonly skill: FactorySkill | null;
  readonly canWrite: boolean;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, factory, skill } = props;
  const id = useId();
  const levels = skill === null ? (["factory", "home"] as const) : skillSaveLevels(skill.source);
  const read = useEnvironmentQuery(
    skill === null
      ? null
      : factoriesEnvironment.skill({
          environmentId,
          input: {
            name: skill.name,
            source: skill.source,
            ...(skill.source === "factory" ? { factoryId: factory.id } : {}),
          },
        }),
  );
  const save = useAtomCommand(factoriesEnvironment.saveSkill, {
    label: "save a skill",
    reportFailure: false,
  });
  const deleteSkill = useAtomCommand(factoriesEnvironment.deleteSkill, {
    label: "delete a skill",
    reportFailure: false,
  });
  const [name, setName] = useState(skill?.name ?? "");
  const [level, setLevel] = useState<FactorySkillLevel>(levels[0] ?? "factory");
  // Null until the person types, so an edit shows the read's text once it arrives.
  const [edited, setEdited] = useState<string | null>(skill === null ? skillTemplate("") : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const body = edited ?? read.data?.body ?? null;
  const copies = skill !== null && skill.source !== level;
  const failureMessage = (failure: unknown, fallback: string) =>
    isSkillError(failure)
      ? failure.message
      : failure instanceof Error && failure.message !== ""
        ? failure.message
        : fallback;

  const submit = async () => {
    if (body === null || saving) return;
    if (!isSkillName(name)) {
      setError(gt("Use lowercase letters, digits, and single hyphens, such as run-checks."));
      return;
    }
    setSaving(true);
    setError(null);
    const result = await save({
      environmentId,
      input: {
        name,
        source: level,
        body,
        ...(level === "factory" ? { factoryId: factory.id } : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setError(
        failureMessage(squashAtomCommandFailure(result), gt("The skill could not be saved.")),
      );
      return;
    }
    props.onClose();
    toastManager.add({ type: "success", title: gt("Skill saved") });
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <SheetHeader>
        <SheetTitle className="me-8">{skill === null ? gt("New skill") : skill.name}</SheetTitle>
        {skill === null ? null : (
          <SheetDescription>
            {copies
              ? gt("Saving makes a copy at the level you pick. The {level} skill stays as it is.", {
                  level: messages(SKILL_SOURCE_LABEL[skill.source]).toLowerCase(),
                })
              : messages(SKILL_SOURCE_LABEL[skill.source])}
          </SheetDescription>
        )}
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">
        {skill === null ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>{gt("Name", { $context: "skill name" })}</Label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={64}
              autoFocus
              autoComplete="off"
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                setEdited((current) => withSkillName(current ?? skillTemplate(""), next));
              }}
            />
            <p className="text-xs text-muted-foreground">
              <T>Lowercase letters, digits, and hyphens.</T>
            </p>
          </div>
        ) : null}
        {props.canWrite && levels.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-level`}>{gt("Save to")}</Label>
            <Select
              value={level}
              onValueChange={(value) => {
                if (value !== null) setLevel(value);
              }}
              items={levels.map((value) => ({
                value,
                label: messages(SKILL_SOURCE_LABEL[value]),
              }))}
            >
              <SelectTrigger id={`${id}-level`} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {levels.map((value) => (
                  <SelectItem key={value} value={value}>
                    {messages(SKILL_SOURCE_LABEL[value])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">{messages(LEVEL_DESCRIPTION[level])}</p>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
          {/* oxlint-disable-next-line t3code/no-untranslated-copy -- a file name */}
          <Label htmlFor={`${id}-body`}>SKILL.md</Label>
          {body === null ? (
            read.error === null ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <p role="alert" className="text-sm text-destructive-foreground">
                {read.error}
              </p>
            )
          ) : (
            <Textarea
              id={`${id}-body`}
              value={body}
              rows={20}
              spellCheck={false}
              readOnly={!props.canWrite}
              onChange={(event) => setEdited(event.target.value)}
            />
          )}
        </div>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        )}
      </div>
      {props.canWrite ? (
        <div className="flex items-center gap-2 border-t px-6 py-4">
          {skill !== null && skill.source !== "builtin" ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="destructive-outline"
                disabled={saving}
                onClick={() => setDeleting(true)}
              >
                <T>Delete skill</T>
              </Button>
              <FactoryConfirmDialog
                open={deleting}
                title={gt("Delete {name}?", { name: skill.name })}
                description={
                  <span className="whitespace-pre-line">{skillDeleteMessage(skill, messages)}</span>
                }
                confirmLabel={gt("Delete skill")}
                onClose={() => setDeleting(false)}
                onConfirm={async () => {
                  const source = skill.source === "home" ? "home" : "factory";
                  const result = await deleteSkill({
                    environmentId,
                    input: {
                      name: skill.name,
                      source,
                      ...(source === "factory" ? { factoryId: factory.id } : {}),
                    },
                  });
                  if (result._tag === "Failure") {
                    return failureMessage(
                      squashAtomCommandFailure(result),
                      gt("The skill could not be deleted."),
                    );
                  }
                  props.onClose();
                  toastManager.add({ type: "success", title: gt("Skill deleted") });
                  return null;
                }}
              />
            </>
          ) : null}
          <Button type="submit" size="sm" className="ms-auto" disabled={body === null || saving}>
            {saving ? gt("Saving…") : copies ? gt("Save copy") : gt("Save skill")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
