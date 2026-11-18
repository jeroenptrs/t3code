import type { EnvironmentId, Factory } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
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

/** A Delete factory button and the confirmation that says what goes with the factory. */
export function DeleteFactoryDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly disabled: boolean;
}) {
  const gt = useGT();
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
    toastManager.add({ type: "success", title: gt("Factory deleted") });
  };

  return (
    <>
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={props.disabled}
        onClick={() => setOpen(true)}
      >
        {gt("Delete factory")}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!deleting) setOpen(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Delete {name}?", { name: factory.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This removes .t3/factories/<Var>{factory.name}</Var>/ with its roles and skills, and
                drops its work items. Its threads move back to Home. This cannot be undone.
              </T>
            </AlertDialogDescription>
            <AlertDialogDescription>
              <T>Its triggers stay. Delete them in Settings if you no longer need them.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={deleting} render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirm()}>
              {deleting ? gt("Deleting…") : gt("Delete factory")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
