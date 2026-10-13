import { assert, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { JiraConfig } from "./JiraConfig.ts";
import * as JiraIdentities from "./JiraIdentities.ts";

const load = (env: Record<string, string>) =>
  JiraConfig.parse(ConfigProvider.fromEnv({ env })).pipe(Effect.result);

const loadOrFail = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const result = yield* load(env);
    assert(result._tag === "Success" && result.success !== undefined);
    return result.success;
  });

const failureMessage = (env: Record<string, string>) =>
  load(env).pipe(Effect.map((result) => (result._tag === "Failure" ? String(result.failure) : "")));

it.effect("Jira is off when no identities are listed", () =>
  Effect.gen(function* () {
    expect(yield* load({})).toMatchObject({ _tag: "Success", success: undefined });
    expect(yield* load({ T3CODE_JIRA_IDENTITIES: " , " })).toMatchObject({
      _tag: "Success",
      success: undefined,
    });
    expect(yield* failureMessage({ T3CODE_JIRA_READER: "bot" })).toContain(
      "T3CODE_JIRA_IDENTITIES",
    );
  }),
);

it.effect("reads a scoped-token identity and normalizes its site", () =>
  Effect.gen(function* () {
    const config = yield* loadOrFail({
      T3CODE_JIRA_IDENTITIES: "bot",
      T3CODE_JIRA_BOT_SITE: "https://Acme.Atlassian.net/",
      T3CODE_JIRA_BOT_TOKEN: " scoped ",
      T3CODE_JIRA_BOT_CLOUD_ID: "cloud-1",
    });
    expect(config.reader).toBe("bot");
    const [identity] = config.identities;
    expect(identity).toMatchObject({
      name: "bot",
      site: "acme.atlassian.net",
      authMethod: "scoped-token",
      cloudId: "cloud-1",
    });
    expect(Redacted.value(identity!.token)).toBe("scoped");
  }),
);

it.effect("an email makes an identity basic auth, and needs no cloud id", () =>
  Effect.gen(function* () {
    const config = yield* loadOrFail({
      T3CODE_JIRA_IDENTITIES: "me",
      T3CODE_JIRA_ME_SITE: "acme.atlassian.net",
      T3CODE_JIRA_ME_TOKEN: "classic",
      T3CODE_JIRA_ME_EMAIL: "me@acme.test",
    });
    expect(config.identities[0]).toMatchObject({
      authMethod: "basic",
      email: "me@acme.test",
      site: "acme.atlassian.net",
    });
  }),
);

it.effect("an explicit reader is honored among several identities", () =>
  Effect.gen(function* () {
    const config = yield* loadOrFail({
      T3CODE_JIRA_IDENTITIES: "ci-bot, reader-bot",
      T3CODE_JIRA_READER: "reader-bot",
      T3CODE_JIRA_CI_BOT_SITE: "acme.atlassian.net",
      T3CODE_JIRA_CI_BOT_TOKEN: "one",
      T3CODE_JIRA_CI_BOT_CLOUD_ID: "cloud-1",
      T3CODE_JIRA_READER_BOT_SITE: "acme.atlassian.net",
      T3CODE_JIRA_READER_BOT_TOKEN: "two",
      T3CODE_JIRA_READER_BOT_CLOUD_ID: "cloud-1",
    });
    expect(config.identities.map((identity) => identity.name)).toEqual(["ci-bot", "reader-bot"]);
    expect(config.reader).toBe("reader-bot");
  }),
);

it.effect("partial or invalid configuration fails naming what is wrong", () =>
  Effect.gen(function* () {
    const scoped = {
      T3CODE_JIRA_IDENTITIES: "bot",
      T3CODE_JIRA_BOT_SITE: "acme.atlassian.net",
      T3CODE_JIRA_BOT_TOKEN: "scoped",
      T3CODE_JIRA_BOT_CLOUD_ID: "cloud-1",
    };
    const { T3CODE_JIRA_BOT_TOKEN: _token, ...missingToken } = scoped;
    expect(yield* failureMessage(missingToken)).toContain("T3CODE_JIRA_BOT_TOKEN");
    const { T3CODE_JIRA_BOT_CLOUD_ID: _cloudId, ...missingCloudId } = scoped;
    expect(yield* failureMessage(missingCloudId)).toContain("T3CODE_JIRA_BOT_CLOUD_ID");
    expect(yield* failureMessage({ ...scoped, T3CODE_JIRA_READER: "other" })).toContain(
      "T3CODE_JIRA_READER other",
    );
    expect(yield* failureMessage({ ...scoped, T3CODE_JIRA_IDENTITIES: "Bot" })).toContain("Bot");
    expect(
      yield* failureMessage({ ...scoped, T3CODE_JIRA_BOT_SITE: "https://acme.atlassian.net/jira" }),
    ).toContain("T3CODE_JIRA_BOT_SITE");
  }),
);

it.effect(
  "reads a site with the reader when it matches, else the first identity on that site",
  () =>
    Effect.gen(function* () {
      const config = yield* loadOrFail({
        T3CODE_JIRA_IDENTITIES: "acme-ci,other,acme-reader",
        T3CODE_JIRA_READER: "acme-reader",
        T3CODE_JIRA_ACME_CI_SITE: "acme.atlassian.net",
        T3CODE_JIRA_ACME_CI_TOKEN: "one",
        T3CODE_JIRA_ACME_CI_CLOUD_ID: "cloud-1",
        T3CODE_JIRA_OTHER_SITE: "other.atlassian.net",
        T3CODE_JIRA_OTHER_TOKEN: "two",
        T3CODE_JIRA_OTHER_CLOUD_ID: "cloud-2",
        T3CODE_JIRA_ACME_READER_SITE: "acme.atlassian.net",
        T3CODE_JIRA_ACME_READER_TOKEN: "three",
        T3CODE_JIRA_ACME_READER_CLOUD_ID: "cloud-1",
      });
      const identities = JiraIdentities.make(config);
      expect(identities.configured).toBe(true);
      expect(identities.list).toEqual([
        { name: "acme-ci", site: "acme.atlassian.net", authMethod: "scoped-token", reader: false },
        { name: "other", site: "other.atlassian.net", authMethod: "scoped-token", reader: false },
        {
          name: "acme-reader",
          site: "acme.atlassian.net",
          authMethod: "scoped-token",
          reader: true,
        },
      ]);
      expect((yield* identities.reader).name).toBe("acme-reader");
      expect((yield* identities.forSite("ACME.atlassian.net")).name).toBe("acme-reader");
      expect((yield* identities.forSite("other.atlassian.net")).name).toBe("other");
      const unknown = yield* identities.forSite("nope.atlassian.net").pipe(Effect.flip);
      expect(unknown.reason).toBe("not-found");

      const unconfigured = JiraIdentities.make(undefined);
      expect(unconfigured.configured).toBe(false);
      expect(unconfigured.list).toEqual([]);
      expect((yield* unconfigured.reader.pipe(Effect.flip)).reason).toBe("not-configured");
    }),
);
