import { useAtomValue } from "@effect/atom-react";
import {
  resolveCustomSnooze,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";

import { TvTextInput } from "../../components/TvTextInput";
import { environmentThreadShells, serverEnvironment } from "../../state/environments";
import {
  deriveThreadActions,
  THREAD_ACTION_LABELS,
  threadActionState,
  type ThreadActionId,
} from "./threadActionList";
import { runThreadAction } from "./threadActions";
import { ThreadSheet, type ThreadSheetRow } from "./ThreadSheet";

const UNITS = ["minutes", "hours", "days"] as const;
type Unit = (typeof UNITS)[number];

const customSnoozeUntil = (amount: string, unit: Unit) =>
  resolveCustomSnooze({ mode: "duration", amount, unit }, new Date());

/**
 * Settle, snooze, pin, and archive for one thread, and their reverses, as mobile's row menu
 * offers them. Menu from the snooze lists returns to the actions.
 */
export function ThreadActionsSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The shell leaves the list once archived; the open thread's projection still knows. */
  readonly archived?: boolean;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = props;
  const ref = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const shell = useAtomValue(environmentThreadShells.threadShellAtom(ref));
  const capabilities = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .capabilities;
  const [view, setView] = useState<"actions" | "snooze" | "custom">("actions");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<Unit>("hours");
  // Read once: the presets and the state stay as they were when the sheet opened.
  const [now] = useState(() => new Date().toISOString());

  const run = async (action: ThreadActionId, snoozedUntil?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    const failure = await runThreadAction({
      environmentId,
      threadId,
      action,
      ...(snoozedUntil ? { snoozedUntil } : {}),
    });
    inFlight.current = false;
    setBusy(false);
    if (failure === null) props.onClose();
    else setNotice(failure);
  };

  const actions =
    shell !== null
      ? deriveThreadActions(threadActionState(shell, now), {
          settlement: capabilities?.threadSettlement === true,
          snooze: capabilities?.threadSnooze === true,
          pinning: capabilities?.threadPinning === true,
        })
      : props.archived
        ? (["unarchive"] as const)
        : [];

  const back = () => {
    setNotice(null);
    setView(view === "custom" ? "snooze" : "actions");
  };
  let rows: ReadonlyArray<ThreadSheetRow>;
  let subtitle: string | null = shell?.title ?? null;
  let children = null;
  if (view === "snooze") {
    subtitle = "Snooze until";
    rows = [
      ...resolveSnoozePresets(new Date(now)).map((preset): ThreadSheetRow => ({
        key: `snooze:${preset.id}`,
        label: preset.label,
        subtitle: preset.whenLabel,
        onPress: () => void run("snooze", preset.snoozedUntil),
      })),
      {
        key: "snooze:custom",
        label: "Custom…",
        onPress: () => {
          setNotice(null);
          setView("custom");
        },
      },
    ];
  } else if (view === "custom") {
    subtitle = "Snooze for";
    children = (
      <TvTextInput
        label="Amount"
        value={amount}
        onChangeText={(value) => {
          setAmount(value);
          setNotice(null);
        }}
        keyboardType="decimal-pad"
        returnKeyType="done"
      />
    );
    rows = [
      {
        key: "custom:unit",
        label: `Unit: ${unit[0]!.toUpperCase()}${unit.slice(1)}`,
        subtitle: "Select to change",
        onPress: () => setUnit(UNITS[(UNITS.indexOf(unit) + 1) % UNITS.length]!),
      },
      {
        key: "custom:confirm",
        label: `Snooze for ${amount.trim() || "?"} ${unit}`,
        tone: "accent",
        onPress: () => {
          const snoozedUntil = customSnoozeUntil(amount, unit);
          if (snoozedUntil === null) setNotice("Enter an amount greater than zero.");
          else void run("snooze", snoozedUntil);
        },
      },
    ];
  } else {
    rows = actions.map((action): ThreadSheetRow => ({
      key: `action:${action}`,
      label: THREAD_ACTION_LABELS[action],
      onPress: () => {
        if (action !== "snooze") return void run(action);
        setNotice(null);
        setView("snooze");
      },
    }));
  }

  return (
    <ThreadSheet
      title={view === "actions" ? "Thread" : "Snooze"}
      subtitle={subtitle}
      notice={
        notice !== null
          ? { text: notice, tone: "danger" }
          : busy
            ? { text: "Working…", tone: "muted" }
            : null
      }
      rows={rows}
      emptyLabel="Loading thread…"
      onClose={view === "actions" ? props.onClose : back}
    >
      {children}
    </ThreadSheet>
  );
}
