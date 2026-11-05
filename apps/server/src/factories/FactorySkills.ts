/**
 * Puts a factory role's skills where every provider looks in the thread's working directory:
 * `.agents/skills/<name>/`, with `.claude/skills/<name>` and `.codex/skills/<name>` linking to it.
 * Git's info/exclude hides each path it adds, so the agent's `git status` stays clean. A skill the
 * role stops binding stays until the worktree goes.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { SKILL_FILE_NAME } from "./factoryFiles.ts";
import { type BoundSkill, FactoryThreads } from "./FactoryThreads.ts";

export class FactorySkills extends Context.Service<
  FactorySkills,
  {
    /**
     * Writes the skills `threadId`'s role binds into `cwd`, changing only files that differ.
     * Does nothing for a thread with no role. Failures are logged, and the session opens anyway.
     */
    readonly materialize: (threadId: ThreadId, cwd: string) => Effect.Effect<void>;
  }
>()("t3/factories/FactorySkills") {}

const SKILLS_ROOT = [".agents", "skills"] as const;
const LINK_ROOTS = [
  [".claude", "skills"],
  [".codex", "skills"],
] as const;
const EXCLUDE_HEADER = "# Skills T3 Code binds for factory roles";

interface SkillFile {
  readonly relative: string;
  readonly bytes: Uint8Array;
  readonly mode: number | null;
}

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* FactoryThreads;
  const git = yield* GitVcsDriver.GitVcsDriver;
  // Linked worktrees share one exclude file, so writes go one at a time.
  const writes = yield* Semaphore.make(1);

  /** None when the path does not exist. */
  const ifExists = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
    effect.pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
      }),
    );

  /** The checkout's top level, its exclude file, and the tracked paths under the skill roots. */
  const repository = Effect.fn("FactorySkills.repository")(function* (cwd: string) {
    const located = yield* git.execute({
      operation: "FactorySkills.repository",
      cwd,
      args: ["rev-parse", "--show-toplevel", "--git-path", "info/exclude"],
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    });
    const [topLevel, excludePath] = located.stdout.split("\n").map((line) => line.trim());
    if (located.exitCode !== 0 || !topLevel || !excludePath) return null;
    const tracked = yield* git.execute({
      operation: "FactorySkills.tracked",
      cwd,
      args: ["ls-files", "-z", "--", ".agents", ".claude", ".codex"],
      timeoutMs: 10_000,
    });
    return {
      topLevel: yield* fileSystem.realPath(topLevel),
      exclude: path.resolve(cwd, excludePath),
      tracked: tracked.stdout.split("\0").filter((entry) => entry.length > 0),
    };
  });

  const skillFiles = Effect.fn("FactorySkills.skillFiles")(function* (skill: BoundSkill) {
    if (skill.source === "builtin") {
      return [
        { relative: SKILL_FILE_NAME, bytes: new TextEncoder().encode(skill.text), mode: null },
      ];
    }
    const entries = yield* fileSystem.readDirectory(skill.directory, { recursive: true });
    const files: Array<SkillFile> = [];
    for (const relative of entries.toSorted()) {
      const source = path.join(skill.directory, relative);
      const info = yield* fileSystem.stat(source);
      if (info.type !== "File") continue;
      files.push({ relative, bytes: yield* fileSystem.readFile(source), mode: info.mode & 0o777 });
    }
    return files;
  });

  const writeIfChanged = Effect.fn("FactorySkills.writeIfChanged")(function* (
    target: string,
    file: SkillFile,
  ) {
    const current = yield* ifExists(fileSystem.readFile(target));
    if (Option.isNone(current) || !sameBytes(current.value, file.bytes)) {
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.writeFile(target, file.bytes);
    }
    if (file.mode !== null && ((yield* fileSystem.stat(target)).mode & 0o777) !== file.mode) {
      yield* fileSystem.chmod(target, file.mode);
    }
  });

  /** Makes `link` reach `directory`; false when something that is not a link is in the way. */
  const linkTo = Effect.fn("FactorySkills.linkTo")(function* (link: string, directory: string) {
    const reached = yield* ifExists(fileSystem.realPath(link));
    if (Option.isSome(reached) && reached.value === (yield* fileSystem.realPath(directory))) {
      return true;
    }
    const existing = yield* ifExists(fileSystem.lstat(link));
    if (Option.isSome(existing) && existing.value.type !== "SymbolicLink") return false;
    if (Option.isSome(existing)) yield* fileSystem.remove(link);
    yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
    yield* fileSystem.symlink(path.relative(path.dirname(link), directory), link);
    return true;
  });

  const materializeSkill = Effect.fn("FactorySkills.materializeSkill")(function* (
    cwd: string,
    skill: BoundSkill,
    tracked: ReadonlyArray<string>,
  ) {
    const roots = [SKILLS_ROOT, ...LINK_ROOTS].map((root) => [...root, skill.name].join("/"));
    if (
      tracked.some((entry) => roots.some((root) => entry === root || entry.startsWith(`${root}/`)))
    ) {
      yield* Effect.logWarning("Skipped a factory skill the checkout tracks", {
        skill: skill.name,
      });
      return [];
    }
    const directory = path.join(cwd, ...SKILLS_ROOT, skill.name);
    const existing = yield* ifExists(fileSystem.lstat(directory));
    if (Option.isSome(existing) && existing.value.type !== "Directory") {
      yield* Effect.logWarning("Skipped a factory skill whose directory is taken", {
        skill: skill.name,
      });
      return [];
    }
    for (const file of yield* skillFiles(skill)) {
      yield* writeIfChanged(path.join(directory, file.relative), file);
    }
    const written = [directory];
    for (const root of LINK_ROOTS) {
      const link = path.join(cwd, ...root, skill.name);
      if (yield* linkTo(link, directory)) written.push(link);
      else yield* Effect.logWarning("Left a skill path that is not a link", { path: link });
    }
    return written;
  });

  /** Adds an anchored line per path to the exclude file, for each line it does not have yet. */
  const exclude = Effect.fn("FactorySkills.exclude")(function* (
    excludePath: string,
    topLevel: string,
    paths: ReadonlyArray<string>,
  ) {
    const lines: Array<string> = [];
    for (const written of paths) {
      // The parent's real path, so a linked skill root such as .claude/skills names its target.
      const parent = yield* fileSystem.realPath(path.dirname(written));
      const relative = path.relative(topLevel, path.join(parent, path.basename(written)));
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      lines.push(`/${relative.split(path.sep).join("/")}`);
    }
    const text = Option.getOrElse(
      yield* ifExists(fileSystem.readFileString(excludePath)),
      () => "",
    );
    const present = new Set(text.split(/\r?\n/));
    const missing = [...new Set(lines)].filter((line) => !present.has(line));
    if (missing.length === 0) return;
    const header = present.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER];
    const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    yield* fileSystem.makeDirectory(path.dirname(excludePath), { recursive: true });
    yield* fileSystem.writeFileString(
      excludePath,
      `${text}${separator}${[...header, ...missing].join("\n")}\n`,
    );
  });

  const materialize: FactorySkills["Service"]["materialize"] = Effect.fn(
    "FactorySkills.materialize",
  )(
    function* (threadId, cwd) {
      const skills = yield* threads.skillsOf(threadId);
      if (skills.length === 0) return;
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const repo = yield* repository(cwd);
          const written = yield* Effect.forEach(skills, (skill) =>
            materializeSkill(cwd, skill, repo?.tracked ?? []),
          );
          if (repo !== null) yield* exclude(repo.exclude, repo.topLevel, written.flat());
        }),
      );
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not bind a factory thread's skills", {
            threadId,
            errorTag: error._tag,
          }),
        ),
      ),
  );

  return FactorySkills.of({ materialize });
});

export const layer = Layer.effect(FactorySkills, make);
