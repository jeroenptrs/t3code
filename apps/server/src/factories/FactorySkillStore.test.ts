import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { makeFactoryId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { parseSkillFile } from "./factoryFiles.ts";
import * as FactorySkillStore from "./FactorySkillStore.ts";
import { builtinSkills } from "./skills/index.ts";

const projectId = ProjectId.make("project-backend");
const factoryId = makeFactoryId(projectId, "triage");

const skillText = (name: string, description?: string) =>
  `---\nname: ${name}\n${description === undefined ? "" : `description: ${description}\n`}---\n\nDo it.\n`;

/**
 * T3 home with `review` (over the built-in one) and `style`, and the triage factory with `style`
 * (over home's) and `lint`.
 */
const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factory-skill-store-" });
  const home = path.join(root, "home");
  const checkout = path.join(root, "backend");
  const factory = path.join(checkout, ".t3", "factories", "triage");
  const files: Record<string, string> = {
    [path.join(factory, "factory.json")]: JSON.stringify({ name: "triage" }),
    [path.join(home, "skills", "review", "SKILL.md")]: skillText("review", "Home review."),
    [path.join(home, "skills", "style", "SKILL.md")]: skillText("style", "Home style."),
    [path.join(factory, "skills", "style", "SKILL.md")]: skillText("style", "Factory style."),
    [path.join(factory, "skills", "lint", "SKILL.md")]: skillText("lint"),
    // A folder without SKILL.md is no skill.
    [path.join(home, "skills", "drafts", "notes.md")]: "Not a skill yet.\n",
  };
  for (const [file, text] of Object.entries(files)) {
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, text);
  }
  const backend = { projectId, workspaceRoot: checkout } as ProjectStore.ProjectRow;
  const layer = FactorySkillStore.layer.pipe(
    Layer.provide(Layer.orDie(ServerConfig.layerTest(root, home))),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id) => Effect.succeed(id === projectId ? Option.some(backend) : Option.none()),
      }),
    ),
  );
  const run = <A, E>(
    use: (store: FactorySkillStore.FactorySkillStore["Service"]) => Effect.Effect<A, E>,
  ) => FactorySkillStore.FactorySkillStore.use(use).pipe(Effect.provide(layer));
  return { home, factory, run };
});

const implement = {
  name: "implement",
  source: "builtin" as const,
  description: parseSkillFile(builtinSkills.implement!).description,
  replaces: null,
};

describe("FactorySkillStore", () => {
  it.effect("resolves each name from the factory, then home, then built-in", () =>
    Effect.gen(function* () {
      const { run } = yield* fixture;
      const home = yield* run((store) => store.list({}));
      const factory = yield* run((store) => store.list({ factoryId }));

      assert.deepStrictEqual(home.skills, [
        implement,
        { name: "review", source: "home", description: "Home review.", replaces: "builtin" },
        { name: "style", source: "home", description: "Home style.", replaces: null },
      ]);
      assert.deepStrictEqual(factory.skills, [
        implement,
        { name: "lint", source: "factory", description: "", replaces: null },
        { name: "review", source: "home", description: "Home review.", replaces: "builtin" },
        { name: "style", source: "factory", description: "Factory style.", replaces: "home" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a skill at each level and names what is missing", () =>
    Effect.gen(function* () {
      const { run } = yield* fixture;
      const builtin = yield* run((store) => store.read({ name: "review", source: "builtin" }));
      const home = yield* run((store) => store.read({ name: "style", source: "home" }));
      const factory = yield* run((store) =>
        store.read({ name: "style", source: "factory", factoryId }),
      );
      const failure = (
        input: Parameters<FactorySkillStore.FactorySkillStore["Service"]["read"]>[0],
      ) =>
        run((store) => store.read(input)).pipe(
          Effect.flip,
          Effect.map((error) => error.code),
        );

      assert.strictEqual(builtin.body, builtinSkills.review);
      assert.strictEqual(home.body, skillText("style", "Home style."));
      assert.deepStrictEqual(factory, {
        skill: {
          name: "style",
          source: "factory",
          description: "Factory style.",
          replaces: "home",
        },
        body: skillText("style", "Factory style."),
      });
      assert.deepStrictEqual(
        [
          yield* failure({ name: "lint", source: "home" }),
          yield* failure({ name: "lint", source: "builtin" }),
          yield* failure({ name: "lint", source: "factory" }),
          yield* failure({
            name: "lint",
            source: "factory",
            factoryId: makeFactoryId(projectId, "nightly"),
          }),
        ],
        ["not_found", "not_found", "factory_not_found", "factory_not_found"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("saves a SKILL.md whose frontmatter names the skill, and refuses any other", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { home, run } = yield* fixture;
      const save = (body: string) =>
        run((store) => store.save({ name: "deploy", source: "home", body }));

      for (const body of [
        "Deploy it.\n",
        "---\n- name: deploy\n---\n",
        "---\nname: [deploy\n---\n",
        skillText("ship"),
      ]) {
        const error = yield* save(body).pipe(Effect.flip);
        assert.strictEqual(error.code, "invalid", body);
      }
      assert.isFalse(yield* fileSystem.exists(`${home}/skills/deploy`));

      const saved = yield* save(skillText("deploy", "Ships it."));
      assert.deepStrictEqual(saved.skill, {
        name: "deploy",
        source: "home",
        description: "Ships it.",
        replaces: null,
      });
      assert.strictEqual(
        yield* fileSystem.readFileString(`${home}/skills/deploy/SKILL.md`),
        skillText("deploy", "Ships it."),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("deletes a skill and its directory once nothing else is in it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { home, factory, run } = yield* fixture;
      yield* fileSystem.writeFileString(`${factory}/skills/lint/check.sh`, "exit 0\n");

      yield* run((store) => store.delete({ name: "style", source: "home" }));
      yield* run((store) => store.delete({ name: "lint", source: "factory", factoryId }));
      const missing = yield* run((store) => store.delete({ name: "style", source: "home" })).pipe(
        Effect.flip,
      );

      assert.isFalse(yield* fileSystem.exists(`${home}/skills/style`));
      assert.deepStrictEqual(yield* fileSystem.readDirectory(`${factory}/skills/lint`), [
        "check.sh",
      ]);
      assert.strictEqual(missing.code, "not_found");
      const { skills } = yield* run((store) => store.list({ factoryId }));
      assert.deepStrictEqual(
        skills.map((skill) => [skill.name, skill.source]),
        [
          ["implement", "builtin"],
          ["review", "home"],
          ["style", "factory"],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
