import { useAtomValue } from "@effect/atom-react";
import {
  jiraIssueKeysEqual,
  parseJiraIssueInput,
  visibleThreadJiraIssues,
} from "@t3tools/client-runtime/state/jira";
import type { JiraIssueKey, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { useJiraIssueLinking } from "~/hooks/useJiraIssueLinking";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell } from "~/state/entities";
import { jiraEnvironment, jiraFailureReason } from "~/state/jira";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";

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
import { JiraStatusBadge } from "./jiraPresentation";

type JiraIssueDialogMode = "link" | "open";

/**
 * Which thread asked for the dialog and what for, set by any entry point (thread details,
 * command palette) and rendered once by the chat view so the dialog outlives a palette that
 * closes the moment its command runs.
 */
const jiraIssueDialogAtom = Atom.make<{
  readonly threadRef: ScopedThreadRef;
  readonly mode: JiraIssueDialogMode;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("jira:issue-dialog"));

export function openJiraIssueDialog(threadRef: ScopedThreadRef, mode: JiraIssueDialogMode): void {
  appAtomRegistry.set(jiraIssueDialogAtom, { threadRef, mode });
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function JiraIssueDialogHost() {
  const request = useAtomValue(jiraIssueDialogAtom);
  if (request === null) return null;
  return (
    <JiraIssueDialog
      key={`${request.threadRef.environmentId}:${request.threadRef.threadId}:${request.mode}`}
      threadRef={request.threadRef}
      mode={request.mode}
      onClose={() => appAtomRegistry.set(jiraIssueDialogAtom, null)}
    />
  );
}

function issueErrorMessage(failure: unknown, error: string | null): string {
  switch (jiraFailureReason(failure)) {
    case "not-found":
      return "The issue does not exist, or the reader identity cannot see it.";
    case "unauthorized":
    case "forbidden":
      return "Jira refused the server's reader identity.";
    case "not-configured":
      return "Jira is not configured on this server.";
    default:
      return error ?? "Could not read the issue.";
  }
}

function JiraIssueDialog(props: {
  threadRef: ScopedThreadRef;
  mode: JiraIssueDialogMode;
  onClose: () => void;
}) {
  const { threadRef, mode, onClose } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const linking = useJiraIssueLinking(threadRef.environmentId);
  const shell = useThreadShell(threadRef);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const parsed = parseJiraIssueInput(text, linking.defaultSite);
  // Typing ABC-1, ABC-12, ABC-123 would otherwise read three issues on the way.
  const checkedKey = useDebouncedValue(
    parsed === null ? null : `${parsed.site}/${parsed.key}`,
    300,
  );
  const checked: JiraIssueKey | null =
    parsed !== null && checkedKey === `${parsed.site}/${parsed.key}` ? parsed : null;
  const issueQuery = useEnvironmentQuery(
    checked === null || !linking.configured
      ? null
      : jiraEnvironment.issue({ environmentId: threadRef.environmentId, input: checked }),
  );
  const issue =
    checked !== null && issueQuery.data !== null && jiraIssueKeysEqual(issueQuery.data, checked)
      ? issueQuery.data
      : null;
  const alreadyLinked =
    parsed !== null &&
    visibleThreadJiraIssues(shell?.source.jiraIssues).some((link) =>
      jiraIssueKeysEqual(link, parsed),
    );

  const validation =
    text.trim().length === 0
      ? null
      : parsed === null
        ? linking.defaultSite === null
          ? "Paste the issue's link."
          : "Use an issue key such as ABC-123, or the issue's link."
        : mode === "link" && alreadyLinked
          ? "This issue is already linked to the thread."
          : checked !== null && issueQuery.error !== null && !issueQuery.isPending
            ? issueErrorMessage(issueQuery.failure, issueQuery.error)
            : null;

  const canSubmit =
    !pending &&
    parsed !== null &&
    (mode === "open" || (issue !== null && !alreadyLinked && linking.canLink));

  const submit = async () => {
    if (!canSubmit || parsed === null) return;
    if (mode === "open") {
      useRightPanelStore.getState().openJiraIssue(threadRef, parsed);
      onClose();
      return;
    }
    setSubmitError(null);
    setPending(true);
    try {
      await linking.changeLink(threadRef, parsed, true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not link the issue.");
      return;
    } finally {
      setPending(false);
    }
    onClose();
  };

  const site = linking.defaultSite;
  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "link" ? "Link Jira issue" : "Open Jira issue"}</DialogTitle>
          <DialogDescription>
            {site === null
              ? "Paste the issue's link."
              : `Enter an issue key on ${site}, or paste the issue's link.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder="ABC-123 or https://…/browse/ABC-123"
            value={text}
            onChange={(event) => {
              setSubmitError(null);
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {issue !== null ? (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <JiraStatusBadge category={issue.statusCategory} status={issue.status} />
              <span className="shrink-0 font-medium">{issue.key}</span>
              <span className="min-w-0 truncate text-muted-foreground">{issue.summary}</span>
            </div>
          ) : parsed !== null && validation === null && mode === "link" ? (
            <p className="truncate text-muted-foreground text-xs">
              Checking {parsed.key} on {parsed.site}…
            </p>
          ) : null}
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            {mode === "open" ? "Open" : pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
