/**
 * Fork-only. The pieces every factory tab shares: the status dot, the issue count on a tab, the
 * save each view sends, and the loading and error states that keep a tab's footprint.
 */
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, Factory, FactoryIssue, FactorySaveInput } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState, type ReactNode } from "react";

import { factoriesEnvironment, factoryErrorOf } from "../../state/factories";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { SettingsGroup } from "../settings/SettingsGroup";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { cn } from "~/lib/utils";
import { canSaveDefinition } from "./FactoryPage.logic";

export type StatusTone = "success" | "warning" | "destructive" | "muted";

const TONE_CLASS: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/40",
};

/** A dot whose tooltip, and accessible name, says what it means. */
export function FactoryStatusDot(props: { readonly tone: StatusTone; readonly label: string }) {
  return <ConnectionStatusDot dotClassName={TONE_CLASS[props.tone]} tooltipText={props.label} />;
}

/** How many problems a tab or row has; nothing while there are none. */
export function FactoryIssueCount({ count }: { readonly count: number }) {
  const gt = useGT();
  if (count === 0) return null;
  return (
    <Badge
      variant="warning"
      size="sm"
      aria-label={gt("{count, plural, =1 {One problem} other {{count} problems}}", { count })}
    >
      {count}
    </Badge>
  );
}

/** Whether this person can save the factory, and why not when they cannot. */
export function useFactoryEditable(
  environmentId: EnvironmentId,
  factory: Factory,
  canManage: boolean,
) {
  const gt = useGT();
  const canSave =
    useAtomValue(factoriesEnvironment.save.permissionAtom(environmentId)) && canManage;
  return {
    editable: canSave,
    blockedReason: canSaveDefinition(factory)
      ? null
      : gt("Fix factory.json before saving. It could not be read."),
  };
}

export interface FactorySaveRefusal {
  readonly message: string;
  readonly issues: ReadonlyArray<FactoryIssue>;
}

/**
 * Sends one save and reports a refusal for the view to show. The factory read refreshes on
 * success, since the command bumps every factory view in the environment.
 */
export function useFactorySave(environmentId: EnvironmentId) {
  const gt = useGT();
  const save = useAtomCommand(factoriesEnvironment.save, {
    label: "save a factory",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const send = async (
    input: FactorySaveInput,
  ): Promise<{ readonly saved: Factory } | { readonly refusal: FactorySaveRefusal }> => {
    setSaving(true);
    const result = await save({ environmentId, input });
    setSaving(false);
    if (result._tag === "Success") return { saved: result.value };
    const error = squashAtomCommandFailure(result);
    const factoryError = factoryErrorOf(error);
    return {
      refusal: {
        message:
          factoryError?.message ??
          (error instanceof Error && error.message !== ""
            ? error.message
            : gt("The factory could not be saved.")),
        issues: factoryError?.issues ?? [],
      },
    };
  };
  return { saving, save: send };
}

/** A save the server refused, above the controls it names. */
export function FactorySaveError({ refusal }: { readonly refusal: FactorySaveRefusal | null }) {
  if (refusal === null) return null;
  return (
    <p role="alert" className="text-sm text-destructive-foreground">
      {refusal.message}
    </p>
  );
}

/** Discard and Save changes for a view with its own unsaved edits. */
export function FactorySaveActions(props: {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly disabledReason?: string | null;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}) {
  const gt = useGT();
  return (
    <div className="flex items-center gap-2">
      {props.dirty ? (
        <Button size="xs" variant="ghost" disabled={props.saving} onClick={props.onDiscard}>
          {gt("Discard", { $context: "button, drops unsaved edits" })}
        </Button>
      ) : null}
      <Button
        size="xs"
        disabled={!props.dirty || props.saving || (props.disabledReason ?? null) !== null}
        title={props.disabledReason ?? undefined}
        onClick={props.onSave}
      >
        {props.saving ? gt("Saving…") : gt("Save changes")}
      </Button>
    </div>
  );
}

/** A card of rows while the factory loads, with the height of the card it stands for. */
export function FactoryCardSkeleton(props: { readonly rows?: number; readonly title?: boolean }) {
  const rows = Array.from({ length: props.rows ?? 3 }, (_, index) => index);
  return (
    <div className="space-y-2.5" aria-hidden>
      {props.title === false ? null : (
        <div className="flex min-h-7 items-center justify-between px-3 sm:px-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-6 w-24" />
        </div>
      )}
      <SettingsGroup>
        {rows.map((row) => (
          <div key={row} className="flex items-center gap-3 px-3 py-3 sm:px-4">
            <Skeleton shape="pill" className="size-2" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-5 w-9" shape="pill" />
          </div>
        ))}
      </SettingsGroup>
    </div>
  );
}

/** A failed read keeps a retry, in place of the content it stands for. */
export function FactoryLoadError(props: {
  readonly title: string;
  readonly message: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.message === null ? null : <EmptyDescription>{props.message}</EmptyDescription>}
      </EmptyHeader>
      <Button size="sm" variant="outline" onClick={props.onRetry}>
        <T>Try again</T>
      </Button>
    </Empty>
  );
}

/** The class a row's link or button takes, to cover the row and make it the target. */
export const ROW_LINK_CLASS =
  "absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * A row in a card that opens something. `link` takes `ROW_LINK_CLASS` and covers the row, so the
 * whole row is the target; `leading` and `trailing` controls sit above it with their own clicks.
 */
export function FactoryRowLink(props: {
  readonly link?: ReactNode;
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-3 px-3 py-2.5 sm:px-4",
        props.link !== undefined && "hover:bg-accent/50",
      )}
    >
      {props.leading === undefined ? null : (
        <span className="relative z-10 flex shrink-0">{props.leading}</span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{props.title}</span>
        {props.meta === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground">{props.meta}</span>
        )}
      </div>
      {props.trailing === undefined ? null : (
        <div className="relative z-10 flex shrink-0 items-center gap-2">{props.trailing}</div>
      )}
      {props.link}
    </div>
  );
}

/**
 * Confirms a destructive action, with focus on Cancel. The confirm button names the action, and
 * stays pending until `onConfirm` settles; a failure keeps the dialog open with its message.
 */
export function FactoryConfirmDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setPending(true);
    setError(null);
    const failure = await props.onConfirm();
    setPending(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    props.onClose();
  };
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          setError(null);
          props.onClose();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : (
          <p role="alert" className="px-6 text-sm text-destructive-foreground">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
            {props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
