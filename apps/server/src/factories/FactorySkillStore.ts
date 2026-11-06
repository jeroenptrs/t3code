/**
 * Skill files at the two levels a person or an agent writes: T3 home's `skills/`, shared by every
 * project on this server, and a factory's own `skills/`. A factory skill replaces a home skill of
 * the same name, and a home skill replaces a built-in one.
 */
import {
  type FactoryId,
  FactorySkillError,
  type FactorySkillLevel,
  type FactorySkillDeleteInput,
  type FactorySkillDeleteResult,
  type FactorySkillListInput,
  type FactorySkillListResult,
  type FactorySkillReadInput,
  type FactorySkillReadResult,
  type FactorySkillSaveInput,
  type FactorySkillSaveResult,
  type FactorySkillSource,
  parseFactoryId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  builtinSkillEntries,
  FACTORIES_DIRECTORY,
  FACTORY_FILE_NAME,
  parseSkillFile,
  readSkillLevel,
  resolveSkills,
  SKILL_FILE_NAME,
  type SkillEntry,
  SKILLS_DIRECTORY,
  toFactorySkill,
} from "./factoryFiles.ts";

export class FactorySkillStore extends Context.Service<
  FactorySkillStore,
  {
    /** Without a factory, home and built-in skills; with one, the factory's effective skills. */
    readonly list: (
      input: FactorySkillListInput,
    ) => Effect.Effect<FactorySkillListResult, FactorySkillError>;
    readonly read: (
      input: FactorySkillReadInput,
    ) => Effect.Effect<FactorySkillReadResult, FactorySkillError>;
    /** Refuses a SKILL.md whose frontmatter a provider would not load as this skill. */
    readonly save: (
      input: FactorySkillSaveInput,
    ) => Effect.Effect<FactorySkillSaveResult, FactorySkillError>;
    /** Removes SKILL.md, and the skill's directory when nothing else is in it. */
    readonly delete: (
      input: FactorySkillDeleteInput,
    ) => Effect.Effect<FactorySkillDeleteResult, FactorySkillError>;
    /**
     * Every skill a role can name, one per name, sorted: the factory's in `factoryDirectory`, then
     * home, then built-in. Null for home and built-in only.
     */
    readonly resolve: (
      factoryDirectory: string | null,
    ) => Effect.Effect<ReadonlyArray<SkillEntry>, PlatformError.PlatformError>;
  }
>()("t3/factories/FactorySkillStore") {}

const unavailable = (operation: "read" | "written") => (cause: PlatformError.PlatformError) =>
  Effect.logWarning(`Skills could not be ${operation}.`, cause).pipe(
    Effect.andThen(
      Effect.fail(
        new FactorySkillError({
          code: "unavailable",
          message: `Skills could not be ${operation}.`,
        }),
      ),
    ),
  );

const notFound = (name: string, source: string) =>
  new FactorySkillError({ code: "not_found", message: `No ${source} skill ${name} exists.` });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const homeSkills = path.join(baseDir, SKILLS_DIRECTORY);

  /** The factory's directory; fails when the id names no factory with a `factory.json`. */
  const factoryDirectory = Effect.fn("FactorySkillStore.factoryDirectory")(function* (
    factoryId: FactoryId | undefined,
  ) {
    const missing = new FactorySkillError({
      code: "factory_not_found",
      message:
        factoryId === undefined
          ? "A factory skill needs a factory id."
          : `No factory ${factoryId} exists here.`,
    });
    const parsed = factoryId === undefined ? null : parseFactoryId(factoryId);
    if (parsed === null) return yield* missing;
    const project = yield* projects.get(parsed.projectId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Skills could not be read.", cause).pipe(
          Effect.andThen(
            Effect.fail(
              new FactorySkillError({
                code: "unavailable",
                message: "Skills could not be read.",
              }),
            ),
          ),
        ),
      ),
    );
    if (Option.isNone(project)) return yield* missing;
    const directory = path.join(project.value.workspaceRoot, ...FACTORIES_DIRECTORY, parsed.name);
    const exists = yield* fileSystem
      .exists(path.join(directory, FACTORY_FILE_NAME))
      .pipe(Effect.catch(unavailable("read")));
    if (!exists) return yield* missing;
    return directory;
  });

  const skillsDirectory = Effect.fn("FactorySkillStore.skillsDirectory")(function* (
    source: FactorySkillLevel,
    factoryId: FactoryId | undefined,
  ) {
    if (source === "home") return homeSkills;
    return path.join(yield* factoryDirectory(factoryId), SKILLS_DIRECTORY);
  });

  /** The level below `source` whose skill `name` applies when this one goes; null for none. */
  const replaced = Effect.fn("FactorySkillStore.replaced")(function* (
    name: string,
    source: FactorySkillSource,
  ) {
    if (source === "factory") {
      const home = yield* fileSystem
        .exists(path.join(homeSkills, name, SKILL_FILE_NAME))
        .pipe(Effect.catch(unavailable("read")));
      if (home) return "home" as const;
    }
    if (source === "builtin") return null;
    return builtinSkillEntries.some((skill) => skill.name === name) ? ("builtin" as const) : null;
  });

  const resolve: FactorySkillStore["Service"]["resolve"] = Effect.fn("FactorySkillStore.resolve")(
    function* (directory) {
      const home = yield* readSkillLevel(fileSystem, path, homeSkills, "home");
      const factory =
        directory === null
          ? []
          : yield* readSkillLevel(
              fileSystem,
              path,
              path.join(directory, SKILLS_DIRECTORY),
              "factory",
            );
      return resolveSkills([builtinSkillEntries, home, factory]);
    },
  );

  const list: FactorySkillStore["Service"]["list"] = Effect.fn("FactorySkillStore.list")(
    function* ({ factoryId }) {
      const directory = factoryId === undefined ? null : yield* factoryDirectory(factoryId);
      const skills = yield* resolve(directory).pipe(Effect.catch(unavailable("read")));
      return { skills: skills.map(toFactorySkill) };
    },
  );

  const read: FactorySkillStore["Service"]["read"] = Effect.fn("FactorySkillStore.read")(
    function* ({ name, source, factoryId }) {
      if (source === "builtin") {
        const builtin = builtinSkillEntries.find((skill) => skill.name === name);
        if (builtin?.source !== "builtin") return yield* notFound(name, source);
        return { skill: toFactorySkill(builtin), body: builtin.text };
      }
      const directory = yield* skillsDirectory(source, factoryId);
      const body = yield* fileSystem
        .readFileString(path.join(directory, name, SKILL_FILE_NAME))
        .pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.fail(notFound(name, source)),
          ),
          Effect.catchTags({ PlatformError: unavailable("read") }),
        );
      const { description } = parseSkillFile(body);
      return {
        skill: { name, source, description, replaces: yield* replaced(name, source) },
        body,
      };
    },
  );

  const save: FactorySkillStore["Service"]["save"] = Effect.fn("FactorySkillStore.save")(
    function* ({ name, source, factoryId, body }) {
      // Providers load a skill by its frontmatter, so a mismatch fails silently there.
      const parsed = parseSkillFile(body);
      if (parsed.problem !== null || parsed.name !== name) {
        return yield* new FactorySkillError({
          code: "invalid",
          message:
            parsed.problem ?? `The frontmatter's name must be ${name}, the skill's directory.`,
        });
      }
      const directory = yield* skillsDirectory(source, factoryId);
      yield* writeFileStringAtomically({
        filePath: path.join(directory, name, SKILL_FILE_NAME),
        contents: body,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catch(unavailable("written")),
      );
      const { description } = parsed;
      return { skill: { name, source, description, replaces: yield* replaced(name, source) } };
    },
  );

  const remove: FactorySkillStore["Service"]["delete"] = Effect.fn("FactorySkillStore.delete")(
    function* ({ name, source, factoryId }) {
      const directory = path.join(yield* skillsDirectory(source, factoryId), name);
      yield* fileSystem.remove(path.join(directory, SKILL_FILE_NAME)).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.fail(notFound(name, source)),
        ),
        Effect.catchTags({ PlatformError: unavailable("written") }),
      );
      const rest = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.catch(unavailable("written")));
      if (rest.length === 0) {
        yield* fileSystem
          .remove(directory, { recursive: true })
          .pipe(Effect.catch(unavailable("written")));
      }
      return { name, source };
    },
  );

  return FactorySkillStore.of({ list, read, save, delete: remove, resolve });
});

export const layer = Layer.effect(FactorySkillStore, make);
