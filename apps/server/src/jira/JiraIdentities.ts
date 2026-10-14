import { JiraError, type JiraIdentity } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { normalizeJiraSite, type JiraConfig, type JiraServerIdentity } from "./JiraConfig.ts";

/** The configured Jira identities. Every UI read goes through the one designated reader. */
export class JiraIdentities extends Context.Service<
  JiraIdentities,
  {
    readonly configured: boolean;
    /** Public shapes, in configuration order. */
    readonly list: ReadonlyArray<JiraIdentity>;
    /** Every configured service identity, in configuration order; never leaves the server. */
    readonly services: ReadonlyArray<JiraServerIdentity>;
    readonly reader: Effect.Effect<JiraServerIdentity, JiraError>;
    /**
     * The identity to read `site` with: the reader when it is on that site, else the first
     * identity configured for it.
     */
    readonly forSite: (site: string) => Effect.Effect<JiraServerIdentity, JiraError>;
  }
>()("t3/jira/JiraIdentities") {}

const notConfigured = new JiraError({
  reason: "not-configured",
  message: "Jira is not configured on this server.",
});

const toPublicIdentity = (identity: JiraServerIdentity, readerName: string): JiraIdentity => ({
  name: identity.name,
  site: identity.site,
  authMethod: identity.authMethod,
  reader: identity.name === readerName,
});

export const make = (config: JiraConfig | undefined): JiraIdentities["Service"] => {
  if (config === undefined) {
    return JiraIdentities.of({
      configured: false,
      list: [],
      services: [],
      reader: Effect.fail(notConfigured),
      forSite: () => Effect.fail(notConfigured),
    });
  }
  const reader = config.identities.find((identity) => identity.name === config.reader)!;
  return JiraIdentities.of({
    configured: true,
    list: config.identities.map((identity) => toPublicIdentity(identity, config.reader)),
    services: config.identities,
    reader: Effect.succeed(reader),
    forSite: (site) => {
      const normalized = normalizeJiraSite(site);
      const identity =
        normalized === reader.site
          ? reader
          : config.identities.find((candidate) => candidate.site === normalized);
      return identity === undefined
        ? Effect.fail(
            new JiraError({
              reason: "not-found",
              message: `No Jira identity is configured for ${normalized ?? "that site"}.`,
            }),
          )
        : Effect.succeed(identity);
    },
  });
};

export const layer = Layer.effect(
  JiraIdentities,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return make(config.jira);
  }),
);
