import { useAtomValue } from "@effect/atom-react";
import {
  canDropWorkItem,
  gateAnswerError,
  gateAnswerInput,
  implementationLabel,
  isDismissedFailure,
  latestImplementation,
  latestReview,
  runningRoles,
  runningRolesLabel,
  workItemActorLabel,
  workItemFailureMessage,
  workItemStageLabel,
} from "@t3tools/client-runtime/factories";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FactoryId,
  WorkItem,
  WorkItemGateDecision,
  WorkItemId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { Sheet } from "../../components/ui/Sheet";
import { factoriesEnvironment } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const INPUT_CLASS = "rounded-lg bg-background px-3 py-2 text-base text-foreground";

function Separated({ children }: { readonly children: ReactNode }) {
  return <View className="border-t border-border-subtle">{children}</View>;
}

/** The roles a working item has a child running as; only working items read the shells. */
function RunningRolesText(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Pick<WorkItem, "threads">;
}) {
  const messages = useMessages();
  // A string, so a shell tick that changes no running role renders nothing.
  const label = useAtomValue(environmentThreadShells.threadShellsAtom, (shells) =>
    runningRolesLabel(runningRoles(props.item, props.environmentId, shells), messages),
  );
  if (label === "") return null;
  return (
    <Text textRole="footnote" className="text-foreground-muted">
      {label}
    </Text>
  );
}

/**
 * The item's stage, and the roles running on it while it works. A failure a person dismissed says
 * so, so it no longer reads as one to act on.
 */
export function WorkItemStageText(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Pick<WorkItem, "stage" | "failureDismissedAt" | "threads">;
}) {
  const gt = useGT();
  const messages = useMessages();
  return (
    <View className="flex-row flex-wrap gap-2">
      <Text
        textRole="footnote"
        className={
          props.item.stage === "failed" && !isDismissedFailure(props.item)
            ? "text-danger-foreground"
            : "text-foreground"
        }
      >
        {workItemStageLabel(props.item.stage, messages)}
      </Text>
      {isDismissedFailure(props.item) ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {gt("Dismissed", { $context: "a failed work item a person no longer needs to act on" })}
        </Text>
      ) : null}
      {props.item.stage === "working" && props.item.threads.length > 0 ? (
        <RunningRolesText environmentId={props.environmentId} item={props.item} />
      ) : null}
    </View>
  );
}

/** One work item: the gate while one waits, the item's actions, the request, and its history. */
export function WorkItemSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly workItemId: WorkItemId;
  readonly onOpenThread: (item: WorkItem) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const query = useEnvironmentQuery(
    factoriesEnvironment.workItem({
      environmentId: props.environmentId,
      input: { workItemId: props.workItemId },
    }),
  );
  const item = query.data;
  return (
    <Sheet title={item?.title ?? gt("Work item")} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-5 pt-2"
        contentContainerStyle={{ paddingBottom: Math.max(20, insets.bottom) }}
      >
        {item !== null ? (
          <WorkItemDetail
            environmentId={props.environmentId}
            item={item}
            onOpenThread={() => props.onOpenThread(item)}
          />
        ) : query.error !== null ? (
          <View className="gap-3">
            <Text selectable textRole="footnote" className="text-danger-foreground">
              {query.error}
            </Text>
            <View className="self-start">
              <Button label={gt("Retry")} size="compact" onPress={query.refresh} />
            </View>
          </View>
        ) : (
          <View
            className="gap-3"
            accessibilityLabel={gt("Loading the work item")}
            accessibilityState={{ busy: true }}
          >
            <View className="h-4 w-1/3 rounded bg-subtle-strong" />
            <View className="h-24 rounded-lg bg-subtle-strong" />
          </View>
        )}
      </ScrollView>
    </Sheet>
  );
}

/** What the children returned as data: the latest implementation and the latest review. */
function WorkItemResults(props: { readonly item: Pick<WorkItem, "threads"> }) {
  const gt = useGT();
  const review = latestReview(props.item);
  const implementation = latestImplementation(props.item);
  return (
    <>
      {implementation === null ? null : (
        <View className="gap-1">
          <Text textRole="footnote" className="font-t3-medium text-foreground">
            <T>Implementation</T>
          </Text>
          <Text selectable textRole="footnote" className="font-mono text-foreground">
            {implementationLabel(implementation)}
          </Text>
          <Text
            textRole="label"
            className={
              implementation.checksPassed ? "text-foreground-muted" : "text-danger-foreground"
            }
          >
            {implementation.checksPassed ? gt("Checks passed") : gt("Checks failed")}
          </Text>
          <Text selectable textRole="footnote" className="text-foreground-muted">
            {implementation.summary}
          </Text>
        </View>
      )}
      {review === null ? null : (
        <View className="gap-2">
          <Text textRole="footnote" className="font-t3-medium text-foreground">
            {review.verdict === "approve"
              ? gt("Review: approved", { $context: "a review verdict" })
              : gt("Review: changes requested", { $context: "a review verdict" })}
          </Text>
          {review.findings.length === 0 ? (
            <Text textRole="footnote" className="text-foreground-muted">
              <T>No findings</T>
            </Text>
          ) : (
            review.findings.map((finding) => (
              <View
                key={`${finding.file ?? ""}:${finding.line ?? ""}:${finding.summary}`}
                className="gap-0.5"
              >
                <Text selectable textRole="footnote" className="text-foreground">
                  {finding.summary}
                </Text>
                <Text textRole="label" className="text-foreground-muted">
                  {[
                    finding.file === undefined
                      ? null
                      : finding.line === undefined
                        ? finding.file
                        : `${finding.file}:${finding.line}`,
                    finding.blocking
                      ? gt("Blocking", { $context: "a review finding" })
                      : gt("Not blocking", { $context: "a review finding" }),
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </Text>
              </View>
            ))
          )}
        </View>
      )}
    </>
  );
}

function WorkItemDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkItem;
  readonly onOpenThread: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, item } = props;
  return (
    <>
      <WorkItemStageText environmentId={environmentId} item={item} />
      {item.stage === "waiting" && item.gate.state === "waiting" ? (
        <GateAnswer
          environmentId={environmentId}
          workItemId={item.id}
          question={item.gate.question}
        />
      ) : null}
      <WorkItemActions
        environmentId={environmentId}
        item={item}
        onOpenThread={props.onOpenThread}
      />
      <WorkItemResults item={item} />
      <View className="gap-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          <T>Request</T>
        </Text>
        <Text selectable textRole="footnote" className="text-foreground">
          {item.source.text}
        </Text>
      </View>
      <View className="gap-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          <T>Stage history</T>
        </Text>
        {item.transitions.length === 0 ? (
          <Text textRole="footnote" className="text-foreground-muted">
            <T>No stage changes yet</T>
          </Text>
        ) : (
          item.transitions.map((transition) => (
            <View key={transition.id} className="gap-0.5">
              <Text textRole="footnote" className="text-foreground">
                {transition.from === transition.to
                  ? workItemStageLabel(transition.to, messages)
                  : gt("{from} to {to}", {
                      from: workItemStageLabel(transition.from, messages),
                      to: workItemStageLabel(transition.to, messages),
                    })}
              </Text>
              <Text textRole="label" className="text-foreground-muted">
                {workItemActorLabel(transition.actor, messages)}{" "}
                <RelativeTime timestamp={transition.at} />
              </Text>
              {transition.note === null || transition.note === "" ? null : (
                <Text selectable textRole="label" className="text-foreground-muted">
                  {transition.note}
                </Text>
              )}
            </View>
          ))
        )}
      </View>
    </>
  );
}

/** The question a gate holds the item on, and for those who may, approve or reject with a note. */
function GateAnswer(props: {
  readonly environmentId: EnvironmentId;
  readonly workItemId: WorkItemId;
  readonly question: string;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canAnswer = useAtomValue(
    factoriesEnvironment.answerWorkItemGate.permissionAtom(props.environmentId),
  );
  const answer = useAtomCommand(factoriesEnvironment.answerWorkItemGate, {
    label: "answer a gate",
    reportFailure: false,
  });
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<WorkItemGateDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (decision: WorkItemGateDecision) => {
    if (sending !== null) return;
    const invalid = gateAnswerError(decision, note, messages);
    setError(invalid);
    if (invalid !== null) return;
    setSending(decision);
    const result = await answer({
      environmentId: props.environmentId,
      input: gateAnswerInput(props.workItemId, decision, note),
    });
    setSending(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(
        workItemFailureMessage(
          squashAtomCommandFailure(result),
          gt("The answer could not be sent."),
          messages,
        ),
      );
    }
  };

  return (
    <View className="gap-3 rounded-lg border border-border p-3">
      <Text textRole="footnote" className="font-t3-medium text-foreground">
        <T>The Foreman asks</T>
      </Text>
      <Text selectable textRole="footnote" className="text-foreground">
        {props.question}
      </Text>
      {canAnswer ? (
        <>
          <TextInput
            accessibilityLabel={gt("Note", { $context: "gate answer note" })}
            placeholder={gt("Optional when you approve")}
            multiline
            editable={sending === null}
            value={note}
            onChangeText={setNote}
            className={`${INPUT_CLASS} min-h-20`}
            textAlignVertical="top"
          />
          {error === null ? null : (
            <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
              {error}
            </Text>
          )}
          <View className="flex-row gap-2">
            <Button
              label={gt("Approve")}
              tone="primary"
              size="compact"
              loading={sending === "approved"}
              disabled={sending !== null}
              onPress={() => void submit("approved")}
            />
            <Button
              label={gt("Reject")}
              size="compact"
              loading={sending === "rejected"}
              disabled={sending !== null}
              onPress={() => void submit("rejected")}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/** Open the run thread, dismiss or restore a failure, and drop an item that has not ended. */
function WorkItemActions(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkItem;
  readonly onOpenThread: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, item } = props;
  const canDismiss = useAtomValue(
    factoriesEnvironment.dismissWorkItemFailure.permissionAtom(environmentId),
  );
  const canDrop = useAtomValue(factoriesEnvironment.dropWorkItem.permissionAtom(environmentId));
  const dismiss = useAtomCommand(factoriesEnvironment.dismissWorkItemFailure, {
    label: "dismiss a work item failure",
    reportFailure: false,
  });
  const drop = useAtomCommand(factoriesEnvironment.dropWorkItem, {
    label: "drop a work item",
    reportFailure: false,
  });
  const [busy, setBusy] = useState<"dismiss" | "drop" | null>(null);
  const dismissed = item.failureDismissedAt !== null;
  const showDismiss = canDismiss && item.stage === "failed";
  const showDrop = canDrop && canDropWorkItem(item);

  const toggleDismissed = async () => {
    setBusy("dismiss");
    const result = await dismiss({
      environmentId,
      input: { workItemId: item.id, dismissed: !dismissed },
    });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(
        dismissed ? gt("Could not restore the failure") : gt("Could not dismiss the failure"),
        workItemFailureMessage(
          squashAtomCommandFailure(result),
          gt("The failure could not be updated."),
          messages,
        ),
      );
    }
  };

  const dropItem = async () => {
    setBusy("drop");
    const result = await drop({ environmentId, input: { workItemId: item.id } });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(
        gt("Could not drop the item"),
        workItemFailureMessage(
          squashAtomCommandFailure(result),
          gt("The item could not be dropped."),
          messages,
        ),
      );
    }
  };

  if (item.foremanThreadId === null && !showDismiss && !showDrop) return null;
  const rows = [
    item.foremanThreadId === null ? null : (
      <ListActionRow key="thread" label={gt("Open run thread")} onPress={props.onOpenThread} />
    ),
    showDismiss ? (
      <ListActionRow
        key="dismiss"
        label={dismissed ? gt("Restore failure") : gt("Dismiss failure")}
        loading={busy === "dismiss"}
        disabled={busy !== null}
        onPress={() => void toggleDismissed()}
      />
    ) : null,
    showDrop ? (
      <ListActionRow
        key="drop"
        tone="danger"
        label={gt("Drop item")}
        loading={busy === "drop"}
        disabled={busy !== null}
        onPress={() =>
          Dialog.confirm({
            title: gt("Drop {title}?", { title: item.title }),
            message: gt(
              "The item ends as dropped and its Foreman thread is told to stop. This cannot be undone.",
            ),
            confirmText: gt("Drop item"),
            destructive: true,
            onConfirm: () => void dropItem(),
          })
        }
      />
    ) : null,
  ].filter((row) => row !== null);
  return (
    <ListSection>
      {rows.map((row, index) => (index === 0 ? row : <Separated key={row.key}>{row}</Separated>))}
    </ListSection>
  );
}

/** Sends a request to the factory's Foreman as a new work item. */
export function NewWorkItemSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly factoryId: FactoryId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
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
          gt("The work item could not be created."),
          messages,
        ),
      );
      return;
    }
    props.onClose();
  };

  return (
    <Sheet title={gt("New work item")} onClose={props.onClose} dismissDisabled={creating}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-5 pt-2 pb-8"
      >
        <View className="gap-1.5">
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            {gt("Title", { $context: "work item title" })}
          </Text>
          <TextInput
            accessibilityLabel={gt("Title", { $context: "work item title" })}
            value={title}
            maxLength={200}
            autoFocus
            autoComplete="off"
            editable={!creating}
            returnKeyType="next"
            onChangeText={setTitle}
            className={INPUT_CLASS}
          />
        </View>
        <View className="gap-1.5">
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            {gt("Request", { $context: "what a work item asks for" })}
          </Text>
          <TextInput
            accessibilityLabel={gt("Request", { $context: "what a work item asks for" })}
            placeholder={gt("What should the factory do?")}
            value={text}
            multiline
            editable={!creating}
            onChangeText={setText}
            className={`${INPUT_CLASS} min-h-32`}
            textAlignVertical="top"
          />
        </View>
        {error === null ? null : (
          <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
            {error}
          </Text>
        )}
        <Button
          label={gt("Create work item")}
          tone="primary"
          loading={creating}
          disabled={!ready}
          onPress={() => void submit()}
        />
      </ScrollView>
    </Sheet>
  );
}
