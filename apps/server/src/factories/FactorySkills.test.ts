import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as FactorySkills from "./FactorySkills.ts";
import * as FactoryThreads from "./FactoryThreads.ts";

const threadId = ThreadId.make("thread-implementer");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-skills-config-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const materialize = (cwd: string, skills: ReadonlyArray<FactoryThreads.BoundSkill>) =>
  FactorySkills.FactorySkills.use((factorySkills) => factorySkills.materialize(threadId, cwd)).pipe(
    Effect.provide(
      FactorySkills.layer.pipe(
        Layer.provide(
          Layer.mock(FactoryThreads.FactoryThreads)({ skillsOf: () => Effect.succeed(skills) }),
        ),
        Layer.provide(layerGit),
      ),
    ),
  );

/** A repository at `<root>/main` with these files committed. Symlinks are `-> target` values. */
const repository = Effect.fn(function* (root: string, files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const main = `${root}/main`;
  yield* git(root, ["init", "--quiet", "--initial-branch=main", main]);
  yield* git(main, ["config", "user.email", "ada@example.com"]);
  yield* git(main, ["config", "user.name", "Ada"]);
  for (const [relative, content] of Object.entries({ "README.md": "# App\n", ...files })) {
    const target = `${main}/${relative}`;
    yield* fileSystem.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    if (content.startsWith("-> ")) yield* fileSystem.symlink(content.slice(3), target);
    else yield* fileSystem.writeFileString(target, content);
  }
  yield* git(main, ["add", "."]);
  yield* git(main, ["commit", "--quiet", "-m", "base"]);
  return main;
});

const excludedPaths = (text: string) => text.split("\n").filter((line) => line.startsWith("/"));

describe("FactorySkills.materialize", () => {
  it.effect(
    "binds a role's skills into a linked worktree, hides them from git, and rewrites nothing again",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factory-skills-" });
        const runChecks = `${root}/factory/skills/run-checks`;
        yield* fileSystem.makeDirectory(`${runChecks}/scripts`, { recursive: true });
        yield* fileSystem.writeFileString(`${runChecks}/SKILL.md`, "---\nname: run-checks\n---\n");
        yield* fileSystem.writeFileString(`${runChecks}/scripts/check.sh`, "#!/bin/sh\nexit 0\n");
        yield* fileSystem.chmod(`${runChecks}/scripts/check.sh`, 0o755);
        const style = `${root}/home/skills/style`;
        yield* fileSystem.makeDirectory(style, { recursive: true });
        yield* fileSystem.writeFileString(`${style}/SKILL.md`, "---\nname: style\n---\n");
        const implementText = "---\nname: implement\n---\n";
        const skills: ReadonlyArray<FactoryThreads.BoundSkill> = [
          { name: "implement", source: "builtin", text: implementText },
          { name: "run-checks", source: "factory", directory: runChecks },
          { name: "style", source: "home", directory: style },
        ];

        const main = yield* repository(root, {});
        const worktree = `${root}/worktree`;
        yield* git(main, ["worktree", "add", "--quiet", "-b", "feature", worktree]);
        yield* materialize(worktree, skills);

        const skillFile = `${worktree}/.agents/skills/implement/SKILL.md`;
        assert.strictEqual(yield* fileSystem.readFileString(skillFile), implementText);
        const script = `${worktree}/.agents/skills/run-checks/scripts/check.sh`;
        assert.strictEqual(yield* fileSystem.readFileString(script), "#!/bin/sh\nexit 0\n");
        assert.strictEqual((yield* fileSystem.stat(script)).mode & 0o777, 0o755);
        assert.strictEqual(
          yield* fileSystem.readFileString(`${worktree}/.agents/skills/style/SKILL.md`),
          "---\nname: style\n---\n",
        );
        for (const linkRoot of [".claude", ".codex", ".grok", ".kiro"]) {
          for (const name of ["implement", "run-checks", "style"]) {
            const link = `${worktree}/${linkRoot}/skills/${name}`;
            assert.strictEqual(yield* fileSystem.readLink(link), `../../.agents/skills/${name}`);
            assert.isTrue(yield* fileSystem.exists(`${link}/SKILL.md`));
          }
        }
        // Linked worktrees share the main checkout's exclude file.
        const exclude = `${main}/.git/info/exclude`;
        const excluded = yield* fileSystem.readFileString(exclude);
        assert.deepStrictEqual(excludedPaths(excluded), [
          "/.agents/skills/implement",
          "/.claude/skills/implement",
          "/.codex/skills/implement",
          "/.grok/skills/implement",
          "/.kiro/skills/implement",
          "/.agents/skills/run-checks",
          "/.claude/skills/run-checks",
          "/.codex/skills/run-checks",
          "/.grok/skills/run-checks",
          "/.kiro/skills/run-checks",
          "/.agents/skills/style",
          "/.claude/skills/style",
          "/.codex/skills/style",
          "/.grok/skills/style",
          "/.kiro/skills/style",
        ]);
        assert.strictEqual(yield* git(worktree, ["status", "--porcelain"]), "");

        const before = Option.getOrThrow((yield* fileSystem.stat(skillFile)).mtime).getTime();
        yield* materialize(worktree, skills);
        assert.strictEqual(yield* fileSystem.readFileString(exclude), excluded);
        const after = Option.getOrThrow((yield* fileSystem.stat(skillFile)).mtime).getTime();
        assert.strictEqual(after, before);
      }).pipe(Effect.scoped, Effect.provide(layerGit)),
  );

  it.effect("leaves a skill the checkout tracks, and a skill root that links to .agents", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factory-skills-" });
      const main = yield* repository(root, {
        ".agents/skills/review/SKILL.md": "The project's own review.\n",
        ".claude/skills": "-> ../.agents/skills",
      });
      yield* materialize(main, [
        { name: "implement", source: "builtin", text: "---\nname: implement\n---\n" },
        { name: "review", source: "builtin", text: "---\nname: review\n---\n" },
      ]);

      assert.strictEqual(
        yield* fileSystem.readFileString(`${main}/.agents/skills/review/SKILL.md`),
        "The project's own review.\n",
      );
      assert.isFalse(yield* fileSystem.exists(`${main}/.codex/skills/review`));
      assert.strictEqual((yield* fileSystem.lstat(`${main}/.claude/skills`)).type, "SymbolicLink");
      assert.isTrue(yield* fileSystem.exists(`${main}/.claude/skills/implement/SKILL.md`));
      assert.strictEqual(
        yield* fileSystem.readLink(`${main}/.codex/skills/implement`),
        "../../.agents/skills/implement",
      );
      assert.deepStrictEqual(
        excludedPaths(yield* fileSystem.readFileString(`${main}/.git/info/exclude`)),
        [
          "/.agents/skills/implement",
          "/.codex/skills/implement",
          "/.grok/skills/implement",
          "/.kiro/skills/implement",
        ],
      );
      assert.strictEqual(yield* git(main, ["status", "--porcelain"]), "");
    }).pipe(Effect.scoped, Effect.provide(layerGit)),
  );
});
