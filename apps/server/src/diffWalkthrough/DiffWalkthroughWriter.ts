import type {
  DiffWalkthrough,
  DiffWalkthroughAnchor,
  DiffWalkthroughError,
  DiffWalkthroughNote,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { clampToChange, type DiffChange } from "../review/diffChange.ts";
import * as DiffWalkthroughChangeReader from "./DiffWalkthroughChangeReader.ts";
import * as DiffWalkthroughService from "./DiffWalkthroughService.ts";

interface LineSpan {
  readonly start: number;
  readonly end: number;
}

/** What holding a walkthrough's notes to its change did to them. */
export interface DiffWalkthroughHold {
  /** False when the change could not be read, and the notes were stored as written. */
  readonly clamped: boolean;
  /** Why the notes were not checked, when they were not. */
  readonly reason?: string;
  /** Notes that covered no line the change touched. */
  readonly dropped: ReadonlyArray<DiffWalkthroughAnchor>;
  /** Notes cut down to the changed lines they cover. */
  readonly narrowed: ReadonlyArray<
    Pick<DiffWalkthroughAnchor, "path" | "side"> & {
      readonly from: LineSpan;
      readonly to: LineSpan;
    }
  >;
}

/**
 * Notes held to the lines a change touched, the way a guide's excerpts are: one that covers none
 * is dropped, one that reaches past them is narrowed. Notes on a withheld file stand as written.
 */
export function holdNotesToChange(
  notes: ReadonlyArray<DiffWalkthroughNote>,
  change: DiffChange,
  withheld: ReadonlySet<string>,
): { readonly notes: ReadonlyArray<DiffWalkthroughNote> } & Omit<
  DiffWalkthroughHold,
  "clamped" | "reason"
> {
  const kept: Array<DiffWalkthroughNote> = [];
  const dropped: Array<DiffWalkthroughAnchor> = [];
  const narrowed: Array<DiffWalkthroughHold["narrowed"][number]> = [];
  for (const note of notes) {
    if (withheld.has(note.path)) {
      kept.push(note);
      continue;
    }
    const { path, side, start, end } = note;
    const clamped = clampToChange(note, change);
    if (clamped === null) {
      dropped.push({ path, side, start, end });
      continue;
    }
    if (clamped.start !== start || clamped.end !== end) {
      narrowed.push({
        path,
        side,
        from: { start, end },
        to: { start: clamped.start, end: clamped.end },
      });
    }
    kept.push(clamped);
  }
  return { notes: kept, dropped, narrowed };
}

/**
 * Every write of a walkthrough goes through here: agents' writes, clients', and the background
 * run's, which must store through `write` too. `DiffWalkthroughService.put` is the raw store.
 */
export class DiffWalkthroughWriter extends Context.Service<
  DiffWalkthroughWriter,
  {
    /**
     * Holds the walkthrough's notes to the lines its target's change touched, then stores it.
     * A change that cannot be read does not block the write: the notes are stored as written and
     * `held.reason` says why.
     */
    readonly write: (walkthrough: DiffWalkthrough) => Effect.Effect<
      {
        readonly walkthrough: DiffWalkthrough;
        readonly held: DiffWalkthroughHold;
      },
      DiffWalkthroughError
    >;
  }
>()("t3/diffWalkthrough/DiffWalkthroughWriter") {}

const make = Effect.gen(function* () {
  const changes = yield* DiffWalkthroughChangeReader.DiffWalkthroughChangeReader;
  const walkthroughs = yield* DiffWalkthroughService.DiffWalkthroughService;

  const write: DiffWalkthroughWriter["Service"]["write"] = Effect.fn("DiffWalkthroughWriter.write")(
    function* (walkthrough) {
      const read = yield* changes.read(walkthrough.target);
      if (!read.held) {
        return {
          walkthrough: yield* walkthroughs.put(walkthrough),
          held: { clamped: false, reason: read.reason, dropped: [], narrowed: [] },
        };
      }
      const { notes, dropped, narrowed } = holdNotesToChange(
        walkthrough.notes,
        read.change,
        read.withheld,
      );
      return {
        walkthrough: yield* walkthroughs.put({ ...walkthrough, notes }),
        held: { clamped: true, dropped, narrowed },
      };
    },
  );

  return DiffWalkthroughWriter.of({ write });
});

export const layer = Layer.effect(DiffWalkthroughWriter, make);
