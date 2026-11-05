import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type TriggerTemplate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import * as TriggerTemplateService from "./TriggerTemplateService.ts";

const projectId = ProjectId.make("project-1");

const template: TriggerTemplate = {
  name: "issue-in-progress",
  title: "Issue enters In Progress",
  source: "jira",
  filters: [{ path: "event.status", op: "equals", value: "{{status}}" }],
  placeholders: [{ name: "status", default: "In Progress" }],
  prompt: "Work on {{event.key}}.",
};

const withService = <A, E>(
  run: (input: {
    readonly service: TriggerTemplateService.TriggerTemplateService["Service"];
    readonly directory: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-trigger-templates-",
    });
    const projects = Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id: projectId,
                title: "Project",
                workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-11-01T00:00:00.000Z",
                updatedAt: "2026-11-01T00:00:00.000Z",
                deletedAt: null,
              })
            : Option.none(),
        ),
    });
    const service = yield* TriggerTemplateService.TriggerTemplateService.pipe(
      Effect.provide(TriggerTemplateService.layer.pipe(Layer.provide(projects))),
    );
    return yield* run({ service, directory: path.join(workspaceRoot, ".t3", "triggers") });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("saves, lists, and deletes templates in the project's .t3/triggers", () =>
  withService(({ service, directory }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      assert.deepStrictEqual(yield* service.list({ projectId }), { templates: [] });

      const saved = yield* service.save({
        projectId,
        template: { ...template, prompt: `${template.prompt}\n\n` },
      });
      assert.deepStrictEqual(saved, { template });
      assert.deepStrictEqual(yield* fileSystem.readDirectory(directory), ["issue-in-progress.md"]);
      assert.deepStrictEqual(yield* service.list({ projectId }), { templates: [template] });

      const renamed = { ...template, title: "Renamed" };
      yield* service.save({ projectId, template: renamed });
      assert.deepStrictEqual(yield* service.list({ projectId }), { templates: [renamed] });

      assert.deepStrictEqual(yield* service.delete({ projectId, name: template.name }), {
        name: template.name,
      });
      assert.deepStrictEqual(yield* service.list({ projectId }), { templates: [] });
      const missing = yield* Effect.flip(service.delete({ projectId, name: template.name }));
      assert.strictEqual(missing.message, "Trigger template issue-in-progress not found.");
      assert.strictEqual(missing.templateName, template.name);
    }),
  ),
);

it.effect("lists the valid templates and skips files that do not parse", () =>
  withService(({ service, directory }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* service.save({ projectId, template });
      yield* fileSystem.writeFileString(path.join(directory, "broken.md"), "No frontmatter\n");
      yield* fileSystem.writeFileString(path.join(directory, "Bad_Name.md"), "---\n---\n");
      yield* fileSystem.writeFileString(path.join(directory, "notes.txt"), "ignored");
      assert.deepStrictEqual(yield* service.list({ projectId }), { templates: [template] });
    }),
  ),
);

it.effect("fails for a project that does not exist", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const otherProjectId = ProjectId.make("missing");
      const error = yield* Effect.flip(service.list({ projectId: otherProjectId }));
      assert.strictEqual(error.message, "Project missing not found.");
      const saveError = yield* Effect.flip(service.save({ projectId: otherProjectId, template }));
      assert.strictEqual(saveError._tag, "TriggerTemplateError");
    }),
  ),
);
