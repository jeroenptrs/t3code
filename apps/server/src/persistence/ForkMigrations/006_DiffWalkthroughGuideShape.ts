import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SIDES: Record<string, string> = { additions: "new", deletions: "old" };

function migrateGroup(group: unknown): unknown {
  if (!isObject(group)) return group;
  const files = Array.isArray(group.files)
    ? group.files.map((file) => (typeof file === "string" ? { path: file } : file))
    : group.files;
  return {
    ...group,
    attention: group.attention ?? null,
    files,
    questions: group.questions ?? [],
  };
}

function migrateNote(note: unknown): unknown {
  if (!isObject(note)) return note;
  const { startLine, endLine, ...rest } = note;
  return {
    ...rest,
    side: typeof note.side === "string" ? (SIDES[note.side] ?? note.side) : note.side,
    start: rest.start ?? startLine,
    end: rest.end ?? endLine,
  };
}

/** The stored document in the new shape, or null when it is not one this migration can read. */
function migrateDiffWalkthroughJson(json: string): string | null {
  let walkthrough: unknown;
  try {
    walkthrough = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(walkthrough)) return null;
  return JSON.stringify({
    ...walkthrough,
    groups: Array.isArray(walkthrough.groups)
      ? walkthrough.groups.map(migrateGroup)
      : walkthrough.groups,
    notes: Array.isArray(walkthrough.notes)
      ? walkthrough.notes.map(migrateNote)
      : walkthrough.notes,
  });
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Walkthroughs take a guided review's vocabulary: notes anchor with path,
  // side new|old, start and end; groups list files as { path, note? } and
  // carry attention and questions. The contract reads only this shape, so
  // every stored document is rewritten once here. A row this cannot parse is
  // left as is; it was already unreadable.
  const rows = yield* sql<{ readonly targetKey: string; readonly walkthroughJson: string }>`
    SELECT target_key AS "targetKey", walkthrough_json AS "walkthroughJson"
    FROM fork_diff_walkthroughs
  `;
  for (const row of rows) {
    const migrated = migrateDiffWalkthroughJson(row.walkthroughJson);
    if (migrated === null || migrated === row.walkthroughJson) continue;
    yield* sql`
      UPDATE fork_diff_walkthroughs
      SET walkthrough_json = ${migrated}
      WHERE target_key = ${row.targetKey}
    `;
  }
});
