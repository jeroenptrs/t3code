import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { useProjects } from "../../state/entities";
import {
  factoriesEnvironment,
  factoryErrorOf,
  type FactoryEnvironment,
} from "../../state/factories";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { factoryNameError } from "./factories.logic";

/** Creates an empty factory in a project, then opens its page to fill in. */
export function NewFactoryDialog(props: {
  readonly environments: ReadonlyArray<FactoryEnvironment>;
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  readonly onClose: () => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const save = useAtomCommand(factoriesEnvironment.save, {
    label: "create a factory",
    reportFailure: false,
  });
  const [chosenEnvironmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [chosenProjectId, setProjectId] = useState<ProjectId | null>(null);
  const [name, setName] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const allProjects = useProjects();
  const targets = props.environments.filter(
    ({ factories, canManage }) => factories !== null && canManage,
  );
  const target =
    targets.find(({ environmentId }) => environmentId === chosenEnvironmentId) ?? targets[0];
  const projects = allProjects
    .filter(
      (project) => project.environmentId === target?.environmentId && project.archivedAt == null,
    )
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const project =
    projects.find(({ id: projectId }) => projectId === chosenProjectId) ?? projects[0];
  const nameError = factoryNameError(name, target?.factories ?? [], project?.id ?? null);

  const submit = async () => {
    setSubmitted(true);
    if (target === undefined || project === undefined || nameError !== null || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await save({
      environmentId: target.environmentId,
      input: {
        projectId: project.id,
        definition: { name: name.trim(), projects: [], triggers: [], roles: {} },
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      const factoryError = factoryErrorOf(error);
      setSaveError(
        factoryError?.issues?.[0]?.message ??
          (error instanceof Error ? error.message : "The factory could not be created."),
      );
      return;
    }
    props.onClose();
    void navigate({
      to: "/factories/$environmentId/$factoryId",
      params: { environmentId: target.environmentId, factoryId: result.value.id },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
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
            <DialogTitle>New factory</DialogTitle>
            <DialogDescription>
              The definition lives in the project under .t3/factories. It starts with the built-in
              foreman, implement, and review roles.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {targets.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <Label>Environment</Label>
                <Select
                  value={target?.environmentId ?? null}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setEnvironmentId(value);
                    setProjectId(null);
                  }}
                  items={targets.map(({ environmentId }) => ({
                    value: environmentId,
                    label: props.environmentLabelById.get(environmentId) ?? environmentId,
                  }))}
                >
                  <SelectTrigger aria-label="Environment">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {targets.map(({ environmentId }) => (
                      <SelectItem key={environmentId} value={environmentId}>
                        {props.environmentLabelById.get(environmentId) ?? environmentId}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label>Project</Label>
              <Select
                value={project?.id ?? null}
                onValueChange={(value) => {
                  if (value !== null) setProjectId(value);
                }}
                items={projects.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.title,
                }))}
              >
                <SelectTrigger aria-label="Project" disabled={projects.length === 0}>
                  <SelectValue placeholder="No projects here" />
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={name}
                placeholder="nightly-triage"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                aria-invalid={submitted && nameError !== null}
                aria-describedby={`${id}-name-hint`}
                onChange={(event) => setName(event.target.value)}
              />
              <p
                id={`${id}-name-hint`}
                className={
                  submitted && nameError !== null
                    ? "text-xs text-destructive-foreground"
                    : "text-xs text-muted-foreground"
                }
              >
                {submitted && nameError !== null
                  ? nameError
                  : "Lowercase letters, digits, and hyphens. It names the folder."}
              </p>
            </div>
            {saveError === null ? null : (
              <p role="alert" className="text-sm text-destructive-foreground">
                {saveError}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || project === undefined}>
              {saving ? "Creating…" : "Create factory"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
