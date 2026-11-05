import { TriggerTemplate } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const decodeTriggerTemplate = Schema.decodeUnknownResult(TriggerTemplate);

/** `name` is the file name without `.md`; the frontmatter never carries it. */
export function parseTriggerTemplateFile(
  name: string,
  contents: string,
): Result.Result<TriggerTemplate, string> {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (match === null) {
    return Result.fail("The file has no YAML frontmatter between --- lines.");
  }
  let frontmatter: unknown;
  try {
    // Failsafe keeps every scalar a string, so `value: 42` and `default: true` stay usable.
    frontmatter = parseYaml(match[1] ?? "", { schema: "failsafe" });
  } catch (error) {
    return Result.fail(
      `The frontmatter is not valid YAML: ${error instanceof Error ? error.message.trim() : String(error)}`,
    );
  }
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    return Result.fail("The frontmatter must be a YAML mapping.");
  }
  const fields = frontmatter as Record<string, unknown>;
  const prompt = contents
    .slice(match[0].length)
    .replace(/^\r?\n/, "")
    .trimEnd();
  return decodeTriggerTemplate({
    name,
    title: fields.title,
    source: fields.source,
    filters: fields.filters ?? [],
    placeholders: fields.placeholders ?? [],
    prompt,
  }).pipe(Result.mapError((error) => error.message));
}

export function formatTriggerTemplateFile(template: TriggerTemplate): string {
  const frontmatter = stringifyYaml({
    title: template.title,
    source: template.source,
    ...(template.filters.length > 0 ? { filters: template.filters } : {}),
    ...(template.placeholders.length > 0 ? { placeholders: template.placeholders } : {}),
  });
  return `---\n${frontmatter}---\n${template.prompt}\n`;
}
