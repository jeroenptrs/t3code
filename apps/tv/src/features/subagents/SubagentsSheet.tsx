import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import type { ThreadId } from "@t3tools/contracts";

import { ThreadSheet } from "../threads/ThreadSheet";
import { presentSubagent, SUBAGENT_TONE_COLORS } from "./subagentPresentation";

/**
 * Mobile's ThreadAgentsSheet as a TV sheet: the current turn's agents with a status dot, name,
 * status, and one line of their latest progress or result. An agent with its own thread opens it.
 */
export function SubagentsSheet(props: {
  readonly turn: ThreadTurnSubagents | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly canOpenThreads: boolean;
  readonly onClose: () => void;
}) {
  const subagents = props.turn?.subagents ?? [];
  return (
    <ThreadSheet
      title="Agents"
      // A read-only row keeps focus inside the sheet when there is nothing to list.
      rows={
        subagents.length === 0
          ? [{ key: "empty", label: "No agents in this turn." }]
          : subagents.map((subagent) => {
              const presented = presentSubagent(subagent);
              const childThreadId = subagent.childThreadId;
              return {
                key: subagent.id,
                label: presented.title,
                subtitle: [presented.statusLabel, presented.detail].filter(Boolean).join("  ·  "),
                dotColor: SUBAGENT_TONE_COLORS[presented.tone],
                ...(childThreadId === null || !props.canOpenThreads
                  ? {}
                  : {
                      onPress: () => {
                        props.onClose();
                        props.onOpenThread(childThreadId);
                      },
                    }),
              };
            })
      }
      onClose={props.onClose}
    />
  );
}
