import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, FactoryId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useId, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { factoriesEnvironment } from "../../state/factories";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { workItemFailureMessage } from "./workItems.logic";

/**
 * Which factory asked for the dialog, set by the factory page or the command palette and rendered
 * by the factory page, so the dialog outlives a palette that closes the moment its command runs.
 */
const newWorkItemDialogAtom = Atom.make<{
  readonly environmentId: EnvironmentId;
  readonly factoryId: FactoryId;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("factories:new-work-item-dialog"));

export function openNewWorkItemDialog(environmentId: EnvironmentId, factoryId: FactoryId): void {
  appAtomRegistry.set(newWorkItemDialogAtom, { environmentId, factoryId });
}

/** Mounted by the factory page; shows the dialog when this factory asked for it. */
export function NewWorkItemDialogHost(props: {
  readonly environmentId: EnvironmentId;
  readonly factoryId: FactoryId;
}) {
  const request = useAtomValue(newWorkItemDialogAtom);
  if (
    request === null ||
    request.environmentId !== props.environmentId ||
    request.factoryId !== props.factoryId
  ) {
    return null;
  }
  return (
    <NewWorkItemDialog
      key={`${request.environmentId}\n${request.factoryId}`}
      environmentId={request.environmentId}
      factoryId={request.factoryId}
      onClose={() => appAtomRegistry.set(newWorkItemDialogAtom, null)}
    />
  );
}

/** Sends a request to the factory's Foreman as a new work item. */
function NewWorkItemDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly factoryId: FactoryId;
  readonly onClose: () => void;
}) {
  const id = useId();
  const create = useAtomCommand(factoriesEnvironment.createWorkItem, {
    label: "create a work item",
    reportFailure: false,
  });
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = title.trim() !== "" && text.trim() !== "";

  const submit = async () => {
    if (!ready || creating) return;
    setCreating(true);
    setError(null);
    const result = await create({
      environmentId: props.environmentId,
      input: { factoryId: props.factoryId, title: title.trim(), text: text.trim() },
    });
    setCreating(false);
    if (result._tag === "Failure") {
      setError(
        workItemFailureMessage(
          squashAtomCommandFailure(result),
          "The work item could not be created.",
        ),
      );
      return;
    }
    props.onClose();
    toastManager.add(
      result.value.stage === "queued"
        ? {
            type: "success",
            title: "Work item queued",
            description: "It goes to the Foreman when the active item ends.",
          }
        : { type: "success", title: "Work item sent to the Foreman" },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New work item</DialogTitle>
            <DialogDescription>
              The Foreman gets the request as a new message and routes it to implement and review.
              While another item is active, this one waits in the queue.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-title`}>Title</Label>
              <Input
                id={`${id}-title`}
                value={title}
                maxLength={200}
                autoFocus
                autoComplete="off"
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-text`}>Request</Label>
              <Textarea
                id={`${id}-text`}
                value={text}
                placeholder="What should the factory do?"
                onChange={(event) => setText(event.target.value)}
              />
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
            <Button type="submit" disabled={!ready || creating}>
              {creating ? "Creating…" : "Create work item"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
