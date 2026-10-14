import type { AuthUserId, JiraAuthMethod } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/** A server-side Jira identity. Only `JiraIdentity` from contracts ever leaves the server. */
export interface JiraServerIdentity {
  readonly name: string;
  /** Lowercase site host, such as `acme.atlassian.net`. */
  readonly site: string;
  readonly authMethod: JiraAuthMethod;
  readonly token: Redacted.Redacted<string>;
  /** Present for `basic`. */
  readonly email?: string | undefined;
  /** When present, requests go through `api.atlassian.com`; always present for `scoped-token`. */
  readonly cloudId?: string | undefined;
  /** Set for a portal user's personal token; `createdAt` is the stored credential's version. */
  readonly personal?: { readonly userId: AuthUserId; readonly createdAt: string } | undefined;
}

export interface JiraConfig {
  /** In `T3CODE_JIRA_IDENTITIES` order; never empty. */
  readonly identities: ReadonlyArray<JiraServerIdentity>;
  /** Name of the identity that serves every UI read. */
  readonly reader: string;
}

const IDENTITY_NAME = /^[a-z0-9-]+$/;

const configError = (message: string) =>
  new Config.ConfigError(new Schema.SchemaError(new SchemaIssue.InvalidValue({ message })));

const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.map((value) => value.trim())),
    Config.map(Option.filter((value) => value.length > 0)),
    Config.map(Option.getOrUndefined),
  );

const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(
    Config.option,
    Config.map(Option.map((secret) => Redacted.make(Redacted.value(secret).trim()))),
    Config.map(Option.filter((secret) => Redacted.value(secret).length > 0)),
    Config.map(Option.getOrUndefined),
  );

/** `acme` → `T3CODE_JIRA_ACME_`; `-` becomes `_`. */
const variablePrefix = (name: string) => `T3CODE_JIRA_${name.toUpperCase().replaceAll("-", "_")}_`;

/** Accepts `https://acme.atlassian.net/` or a bare `acme.atlassian.net`; returns the lowercase host. */
export const normalizeJiraSite = (value: string): string | null => {
  const trimmed = value.trim();
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) return null;
  const url = new URL(candidate);
  if (
    url.host === "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url.host.toLowerCase();
};

const identityConfig = (name: string) => {
  const prefix = variablePrefix(name);
  return Config.all({
    site: optionalString(`${prefix}SITE`),
    token: optionalSecret(`${prefix}TOKEN`),
    email: optionalString(`${prefix}EMAIL`),
    cloudId: optionalString(`${prefix}CLOUD_ID`),
  });
};

/**
 * Jira is off when `T3CODE_JIRA_IDENTITIES` is unset or empty. Once it names identities, every
 * one of them must be complete; anything partial is a startup error naming what is missing.
 */
export const JiraConfig = optionalString("T3CODE_JIRA_IDENTITIES").pipe(
  Config.flatMap((list) => {
    const names = (list ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return Config.all({
      names: Config.succeed(names),
      reader: optionalString("T3CODE_JIRA_READER"),
      identities: Config.all(names.map(identityConfig)),
    });
  }),
  Config.mapEffect(
    ({
      names,
      reader,
      identities: raw,
    }): Effect.Effect<JiraConfig | undefined, Config.ConfigError> => {
      if (names.length === 0) {
        return reader === undefined
          ? Effect.succeed(undefined)
          : Effect.fail(
              configError(
                "T3CODE_JIRA_READER is set but T3CODE_JIRA_IDENTITIES is not. Set both, or unset it.",
              ),
            );
      }
      const invalid = names.filter((name) => !IDENTITY_NAME.test(name));
      if (invalid.length > 0) {
        return Effect.fail(
          configError(
            `T3CODE_JIRA_IDENTITIES names must be lowercase letters, digits and dashes: ${invalid.join(", ")}.`,
          ),
        );
      }
      const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
      if (duplicates.length > 0) {
        return Effect.fail(
          configError(`T3CODE_JIRA_IDENTITIES lists ${[...new Set(duplicates)].join(", ")} twice.`),
        );
      }
      const missing = names.flatMap((name, index) => {
        const prefix = variablePrefix(name);
        const identity = raw[index]!;
        return [
          identity.site === undefined ? `${prefix}SITE` : null,
          identity.token === undefined ? `${prefix}TOKEN` : null,
          identity.email === undefined && identity.cloudId === undefined
            ? `${prefix}CLOUD_ID (or ${prefix}EMAIL for basic auth)`
            : null,
        ].filter((variable) => variable !== null);
      });
      if (missing.length > 0) {
        return Effect.fail(
          configError(`Jira is partially configured. Also set ${missing.join(", ")}.`),
        );
      }
      const identities: Array<JiraServerIdentity> = [];
      for (const [index, name] of names.entries()) {
        const identity = raw[index]!;
        const site = normalizeJiraSite(identity.site!);
        if (site === null) {
          return Effect.fail(
            configError(
              `${variablePrefix(name)}SITE must be a Jira site such as acme.atlassian.net or https://acme.atlassian.net.`,
            ),
          );
        }
        identities.push({
          name,
          site,
          token: identity.token!,
          ...(identity.email !== undefined
            ? { authMethod: "basic" as const, email: identity.email }
            : { authMethod: "scoped-token" as const }),
          ...(identity.cloudId === undefined ? {} : { cloudId: identity.cloudId }),
        });
      }
      const readerName = reader ?? names[0]!;
      if (!names.includes(readerName)) {
        return Effect.fail(
          configError(
            `T3CODE_JIRA_READER ${readerName} is not one of T3CODE_JIRA_IDENTITIES (${names.join(", ")}).`,
          ),
        );
      }
      return Effect.succeed({ identities, reader: readerName });
    },
  ),
);
