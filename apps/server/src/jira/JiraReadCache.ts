import type { JiraError } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";

/** How long each kind of Jira read is reused. Failures are never cached. */
const JIRA_READ_TTL = {
  search: Duration.seconds(60),
  issue: Duration.seconds(30),
  filters: Duration.minutes(5),
  filter: Duration.minutes(5),
  fields: Duration.hours(1),
  myself: Duration.minutes(5),
  createMeta: Duration.seconds(60),
  sprints: Duration.seconds(60),
  // Closed sprints change rarely, and a velocity read pages through hundreds of issues.
  velocity: Duration.minutes(5),
} as const;
export type JiraReadKind = keyof typeof JIRA_READ_TTL;

const CAPACITY = 1024;

/** Equal by kind and key only, so concurrent reads of one key share a single lookup. */
class Read {
  readonly kind: JiraReadKind;
  readonly key: string;
  readonly lookup: Effect.Effect<unknown, JiraError>;
  constructor(kind: JiraReadKind, key: string, lookup: Effect.Effect<unknown, JiraError>) {
    this.kind = kind;
    this.key = key;
    this.lookup = lookup;
  }
  [Equal.symbol](that: unknown): boolean {
    return that instanceof Read && that.kind === this.kind && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(`${this.kind}\u0000${this.key}`);
  }
}

/**
 * In-memory cache for Jira reads, keyed by kind and a caller-built key that names the identity
 * and the request. A key must always map to the same value type within its kind. `refresh` runs
 * a fresh lookup, joining neither a stored nor an in-flight one, and stores its result.
 */
export class JiraReadCache extends Context.Service<
  JiraReadCache,
  {
    readonly get: <A>(
      kind: JiraReadKind,
      key: string,
      lookup: Effect.Effect<A, JiraError>,
      options?: { readonly refresh?: boolean | undefined },
    ) => Effect.Effect<A, JiraError>;
    /** Drops a stored read, so the next `get` of it asks Jira; used after a write changes it. */
    readonly invalidate: (kind: JiraReadKind, key: string) => Effect.Effect<void>;
  }
>()("t3/jira/JiraReadCache") {}

export const make = Effect.gen(function* () {
  const cache = yield* Cache.makeWith((read: Read) => read.lookup, {
    capacity: CAPACITY,
    timeToLive: (exit, read) => (Exit.isSuccess(exit) ? JIRA_READ_TTL[read.kind] : Duration.zero),
  });
  return JiraReadCache.of({
    get: <A>(
      kind: JiraReadKind,
      key: string,
      lookup: Effect.Effect<A, JiraError>,
      options?: { readonly refresh?: boolean | undefined },
    ) => {
      const read = new Read(kind, key, lookup);
      // The key namespace is per kind and per request, so the stored value is the lookup's `A`.
      return (
        options?.refresh ? Cache.refresh(cache, read) : Cache.get(cache, read)
      ) as Effect.Effect<A, JiraError>;
    },
    // Equality ignores the lookup, so a placeholder names the stored read.
    invalidate: (kind, key) => Cache.invalidate(cache, new Read(kind, key, Effect.void)),
  });
});

export const layer = Layer.effect(JiraReadCache, make);
