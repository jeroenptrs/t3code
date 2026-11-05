/**
 * TriggerTemplateService - named trigger definitions stored as Markdown files in a project's
 * `.t3/triggers/` directory, so they travel with the repository.
 *
 * @module TriggerTemplateService
 */
import {
  TriggerTemplateError,
  type ProjectId,
  type TriggerTemplateDeleteInput,
  type TriggerTemplateDeleteResult,
  type TriggerTemplateListInput,
  type TriggerTemplateListResult,
  type TriggerTemplateSaveInput,
  type TriggerTemplateSaveResult,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ProjectService from "../project/ProjectService.ts";
import { formatTriggerTemplateFile, parseTriggerTemplateFile } from "./triggerTemplateFile.ts";

export class TriggerTemplateService extends Context.Service<
  TriggerTemplateService,
  {
    readonly list: (
      input: TriggerTemplateListInput,
    ) => Effect.Effect<TriggerTemplateListResult, TriggerTemplateError>;
    readonly save: (
      input: TriggerTemplateSaveInput,
    ) => Effect.Effect<TriggerTemplateSaveResult, TriggerTemplateError>;
    readonly delete: (
      input: TriggerTemplateDeleteInput,
    ) => Effect.Effect<TriggerTemplateDeleteResult, TriggerTemplateError>;
  }
>()("t3/triggers/TriggerTemplateService") {}

const TEMPLATE_EXTENSION = ".md";

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;

  const templatesDirectory = Effect.fn("TriggerTemplateService.templatesDirectory")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new TriggerTemplateError({ message: "Could not read the project.", cause }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new TriggerTemplateError({ message: `Project ${projectId} not found.` });
    }
    return path.join(project.value.workspaceRoot, ".t3", "triggers");
  });

  const list: TriggerTemplateService["Service"]["list"] = Effect.fn("TriggerTemplateService.list")(
    function* ({ projectId }) {
      const directory = yield* templatesDirectory(projectId);
      const entries = yield* fileSystem.readDirectory(directory).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed([]),
        ),
        Effect.mapError(
          (cause) =>
            new TriggerTemplateError({ message: "Could not list trigger templates.", cause }),
        ),
      );
      const files = entries.filter((entry) => entry.endsWith(TEMPLATE_EXTENSION)).toSorted();
      const templates = yield* Effect.forEach(files, (file) =>
        fileSystem.readFileString(path.join(directory, file)).pipe(
          Effect.map((contents) =>
            parseTriggerTemplateFile(file.slice(0, -TEMPLATE_EXTENSION.length), contents),
          ),
          Effect.flatMap((parsed) =>
            Result.isSuccess(parsed)
              ? Effect.succeedSome(parsed.success)
              : Effect.logWarning("Skipping an invalid trigger template", {
                  file,
                  problem: parsed.failure,
                }).pipe(Effect.as(Option.none())),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Skipping an unreadable trigger template", {
              file,
              errorTag: error.reason._tag,
            }).pipe(Effect.as(Option.none())),
          ),
        ),
      );
      return { templates: templates.flatMap(Option.toArray) };
    },
  );

  const save: TriggerTemplateService["Service"]["save"] = Effect.fn("TriggerTemplateService.save")(
    function* ({ projectId, template }) {
      const directory = yield* templatesDirectory(projectId);
      const contents = formatTriggerTemplateFile(template);
      // Returns what `list` will read back, which drops trailing whitespace from the prompt.
      const saved = parseTriggerTemplateFile(template.name, contents);
      if (Result.isFailure(saved)) {
        return yield* new TriggerTemplateError({
          message: `The template cannot be stored: ${saved.failure}`,
          templateName: template.name,
        });
      }
      yield* writeFileStringAtomically({
        filePath: path.join(directory, `${template.name}${TEMPLATE_EXTENSION}`),
        contents,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new TriggerTemplateError({
              message: "Could not write the trigger template.",
              templateName: template.name,
              cause,
            }),
        ),
      );
      return { template: saved.success };
    },
  );

  const remove: TriggerTemplateService["Service"]["delete"] = Effect.fn(
    "TriggerTemplateService.delete",
  )(function* ({ projectId, name }) {
    const directory = yield* templatesDirectory(projectId);
    yield* fileSystem.remove(path.join(directory, `${name}${TEMPLATE_EXTENSION}`)).pipe(
      Effect.mapError((cause) =>
        cause.reason._tag === "NotFound"
          ? new TriggerTemplateError({
              message: `Trigger template ${name} not found.`,
              templateName: name,
            })
          : new TriggerTemplateError({
              message: "Could not delete the trigger template.",
              templateName: name,
              cause,
            }),
      ),
    );
    return { name };
  });

  return TriggerTemplateService.of({ list, save, delete: remove });
});

export const layer = Layer.effect(TriggerTemplateService, make);
