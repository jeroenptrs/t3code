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
 * and the request. A key must always map to the same value type within its kind.
 */
export class JiraReadCache extends Context.Service<
  JiraReadCache,
  {
    readonly get: <A>(
      kind: JiraReadKind,
      key: string,
      lookup: Effect.Effect<A, JiraError>,
    ) => Effect.Effect<A, JiraError>;
  }
>()("t3/jira/JiraReadCache") {}

export const make = Effect.gen(function* () {
  const cache = yield* Cache.makeWith((read: Read) => read.lookup, {
    capacity: CAPACITY,
    timeToLive: (exit, read) => (Exit.isSuccess(exit) ? JIRA_READ_TTL[read.kind] : Duration.zero),
  });
  return JiraReadCache.of({
    get: <A>(kind: JiraReadKind, key: string, lookup: Effect.Effect<A, JiraError>) =>
      // The key namespace is per kind and per request, so the stored value is the lookup's `A`.
      Cache.get(cache, new Read(kind, key, lookup)) as Effect.Effect<A, JiraError>,
  });
});

export const layer = Layer.effect(JiraReadCache, make);
