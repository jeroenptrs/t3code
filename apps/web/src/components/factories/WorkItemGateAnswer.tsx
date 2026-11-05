import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, WorkItemGateDecision, WorkItemId } from "@t3tools/contracts";
import { useId, useState } from "react";

import { factoriesEnvironment } from "../../state/factories";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { gateAnswerError, gateAnswerInput, workItemFailureMessage } from "./workItems.logic";

/** The question a gate holds the item on, and for administrators, approve or reject with a note. */
export function WorkItemGateAnswer(props: {
  readonly environmentId: EnvironmentId;
  readonly workItemId: WorkItemId;
  readonly question: string;
}) {
  const id = useId();
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
    const invalid = gateAnswerError(decision, note);
    setError(invalid);
    if (invalid !== null) return;
    setSending(decision);
    const result = await answer({
      environmentId: props.environmentId,
      input: gateAnswerInput(props.workItemId, decision, note),
    });
    setSending(null);
    if (result._tag === "Failure") {
      setError(
        workItemFailureMessage(squashAtomCommandFailure(result), "The answer could not be sent."),
      );
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">The Foreman asks</p>
        <p className="text-sm whitespace-pre-wrap">{props.question}</p>
      </div>
      {canAnswer ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-note`}>Note</Label>
            <Textarea
              id={`${id}-note`}
              size="sm"
              value={note}
              placeholder="Optional when you approve"
              disabled={sending !== null}
              aria-invalid={error !== null && note.trim() === ""}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="xs" disabled={sending !== null} onClick={() => void submit("approved")}>
              {sending === "approved" ? "Approving…" : "Approve"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={sending !== null}
              onClick={() => void submit("rejected")}
            >
              {sending === "rejected" ? "Rejecting…" : "Reject"}
            </Button>
          </div>
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
