import type { EnvironmentId, Factory } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { factoriesEnvironment } from "../../state/factories";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** A Delete button and the confirmation that says what goes with the factory. */
export function DeleteFactoryDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly disabled: boolean;
}) {
  const { environmentId, factory } = props;
  const remove = useAtomCommand(factoriesEnvironment.delete, "delete a factory");
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    const result = await remove({ environmentId, input: { factoryId: factory.id } });
    setDeleting(false);
    if (result._tag === "Failure") return;
    setOpen(false);
    await navigate({ to: "/" });
    toastManager.add({ type: "success", title: "Factory deleted" });
  };

  return (
    <>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={props.disabled}
        onClick={() => setOpen(true)}
      >
        Delete
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!deleting) setOpen(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {factory.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes .t3/factories/{factory.name}/ with its roles and skills, and drops its
              work items. Its threads move back to Home.
            </AlertDialogDescription>
            <AlertDialogDescription>
              Its scheduled tasks stay. Delete them in Settings if you no longer need them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={deleting} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirm()}>
              {deleting ? "Deleting…" : "Delete factory"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
