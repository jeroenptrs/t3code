/**
 * Fork-only. The skills a factory's roles can bind, each from the highest level that has it: the
 * factory's own, T3 home's, or the built-in one. Administrators create, edit, and delete the
 * factory and home levels here.
 */
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
import { useId, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { factoriesEnvironment } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  SKILL_SOURCE_LABEL,
  skillDeleteMessage,
  skillSaveLevels,
  skillTemplate,
  withSkillName,
} from "./FactoryPage.logic";

const isSkillName = Schema.is(FactorySkillName);
const isSkillError = Schema.is(FactorySkillError);

const LEVEL_DESCRIPTION: Readonly<Record<FactorySkillLevel, string>> = {
  factory: "Only this factory's roles see it.",
  home: "Every project on this server sees it, unless a factory has its own.",
};

const failureMessage = (failure: unknown, fallback: string) =>
  isSkillError(failure) ? failure.message : failure instanceof Error ? failure.message : fallback;

/** Which dialog is open: a new skill, or an edit of one the list shows. */
type SkillDialog =
  | { readonly kind: "new" }
  | { readonly kind: "edit"; readonly skill: FactorySkill };

export function FactorySkillsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly canManage: boolean;
}) {
  const { environmentId, factory } = props;
  const canWrite =
    useAtomValue(factoriesEnvironment.saveSkill.permissionAtom(environmentId)) && props.canManage;
  const deleteSkill = useAtomCommand(factoriesEnvironment.deleteSkill, "delete a skill");
  const [dialog, setDialog] = useState<SkillDialog | null>(null);

  const remove = async (skill: FactorySkill) => {
    if (skill.source === "builtin") return;
    const confirmed =
      (await requestConfirmDialog(skillDeleteMessage(skill), { variant: "destructive" })) ?? false;
    if (!confirmed) return;
    const result = await deleteSkill({
      environmentId,
      input: {
        name: skill.name,
        source: skill.source,
        ...(skill.source === "factory" ? { factoryId: factory.id } : {}),
      },
    });
    if (result._tag === "Success") toastManager.add({ type: "success", title: "Skill deleted" });
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Skills</h2>
        {canWrite ? (
          <Button size="xs" variant="outline" onClick={() => setDialog({ kind: "new" })}>
            New skill
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        What a role can bind. This factory's skill replaces a home skill of the same name, which
        replaces a built-in one.
      </p>
      <ul className="flex flex-col gap-3">
        {factory.skills.map((skill) => (
          <li key={skill.name} className="flex min-w-0 items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="flex items-center gap-1.5 text-sm">
                <span className="truncate">{skill.name}</span>
                <Badge variant={skill.source === "builtin" ? "outline" : "secondary"}>
                  {SKILL_SOURCE_LABEL[skill.source]}
                </Badge>
              </p>
              {skill.description === "" ? null : (
                <p className="text-xs text-muted-foreground">{skill.description}</p>
              )}
            </div>
            {canWrite ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setDialog({ kind: "edit", skill })}
                >
                  {skill.source === "factory" ? "Edit" : "Customize"}
                </Button>
                {skill.source === "builtin" ? null : (
                  <Button size="xs" variant="ghost" onClick={() => void remove(skill)}>
                    Delete
                  </Button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {dialog === null ? null : (
        <SkillEditorDialog
          key={dialog.kind === "new" ? "new" : `${dialog.skill.source}:${dialog.skill.name}`}
          environmentId={environmentId}
          factory={factory}
          skill={dialog.kind === "new" ? null : dialog.skill}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

/** Creates a skill, or saves an edit of one at the level the person picks. */
function SkillEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  /** Null for a new skill. */
  readonly skill: FactorySkill | null;
  readonly onClose: () => void;
}) {
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
  const [name, setName] = useState(skill?.name ?? "");
  const [level, setLevel] = useState<FactorySkillLevel>(levels[0] ?? "factory");
  // Null until the person types, so an edit shows the read's text once it arrives.
  const [edited, setEdited] = useState<string | null>(skill === null ? skillTemplate("") : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = edited ?? read.data?.body ?? null;
  const ready = isSkillName(name) && body !== null && !saving;
  const copies = skill !== null && skill.source !== level;

  const submit = async () => {
    if (!ready) return;
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
      setError(failureMessage(squashAtomCommandFailure(result), "The skill could not be saved."));
      return;
    }
    props.onClose();
    toastManager.add({ type: "success", title: "Skill saved" });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{skill === null ? "New skill" : skill.name}</DialogTitle>
            <DialogDescription>
              {skill === null
                ? "The whole SKILL.md. Its frontmatter name must match the skill's name."
                : copies
                  ? `This saves a copy at the level you pick. The ${SKILL_SOURCE_LABEL[skill.source].toLowerCase()} skill stays as it is.`
                  : "The whole SKILL.md. Its frontmatter name must stay the skill's name."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {skill === null ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  maxLength={64}
                  autoFocus
                  autoComplete="off"
                  placeholder="run-checks"
                  onChange={(event) => {
                    const next = event.target.value;
                    setName(next);
                    setEdited((current) => withSkillName(current ?? skillTemplate(""), next));
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Lowercase letters, digits, and hyphens.
                </p>
              </div>
            ) : null}
            {levels.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-level`}>Save to</Label>
                <Select
                  value={level}
                  onValueChange={(value) => {
                    if (value !== null) setLevel(value);
                  }}
                  items={levels.map((value) => ({ value, label: SKILL_SOURCE_LABEL[value] }))}
                >
                  <SelectTrigger id={`${id}-level`} size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {levels.map((value) => (
                      <SelectItem key={value} value={value}>
                        {SKILL_SOURCE_LABEL[value]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">{LEVEL_DESCRIPTION[level]}</p>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-body`}>SKILL.md</Label>
              {body === null ? (
                <p className="text-sm text-muted-foreground" role="status">
                  {read.error ?? "Loading the skill…"}
                </p>
              ) : (
                <Textarea
                  id={`${id}-body`}
                  value={body}
                  rows={16}
                  spellCheck={false}
                  className="max-h-[60vh] overflow-y-auto"
                  onChange={(event) => setEdited(event.target.value)}
                />
              )}
            </div>
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              {saving ? "Saving…" : copies ? "Save copy" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
