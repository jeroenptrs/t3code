/**
 * The factory definition files: parsing them into what the service reports, rendering them back,
 * and checking role bindings against the provider catalog. Pure functions; the service does I/O.
 */
import {
  FactoryDefinition,
  type FactoryEffectiveBinding,
  FactoryIsolation,
  type FactoryIssue,
  FactoryName,
  type FactoryProject,
  FactoryRoleBinding,
  type FactoryRoleName,
  FactoryTrigger,
  ModelSelection,
  type ProjectId,
  ProviderInteractionMode,
  type ProviderOptionDescriptor,
  RuntimeMode,
  type ServerProvider,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const FACTORY_FILE_NAME = "factory.json";

export const defaultRolePath = (role: FactoryRoleName) => `roles/${role}.md`;

const issue = (
  code: FactoryIssue["code"],
  role: FactoryRoleName | null,
  field: string | null,
  message: string,
): FactoryIssue => ({ code, role, field, message });

const decodeName = Schema.decodeUnknownOption(FactoryName);
const decodeNames = Schema.decodeUnknownOption(Schema.Array(TrimmedNonEmptyString));
const decodeTriggers = Schema.decodeUnknownOption(Schema.Array(FactoryTrigger));
const decodeRoles = Schema.decodeUnknownOption(FactoryDefinition.fields.roles);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const emptyDefinition = (name: string): FactoryDefinition => ({
  name,
  projects: [],
  triggers: [],
  roles: {},
});

/**
 * `factory.json` in the directory `directoryName`. The directory names the factory, so a file that
 * names another one, or none, is reported and read under the directory's name. Missing lists are
 * empty; a field with the wrong shape is reported and read as empty.
 */
export function parseFactoryJson(
  directoryName: string,
  text: string,
): { readonly definition: FactoryDefinition; readonly issues: ReadonlyArray<FactoryIssue> } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      definition: emptyDefinition(directoryName),
      issues: [issue("invalid_definition", null, null, `${FACTORY_FILE_NAME} is not valid JSON.`)],
    };
  }
  if (!isRecord(raw)) {
    return {
      definition: emptyDefinition(directoryName),
      issues: [issue("invalid_definition", null, null, `${FACTORY_FILE_NAME} must be an object.`)],
    };
  }
  const issues: Array<FactoryIssue> = [];
  if (Option.getOrUndefined(decodeName(raw.name)) !== directoryName) {
    issues.push(
      issue(
        "name_mismatch",
        null,
        "name",
        `"name" must be "${directoryName}", the name of the factory's directory.`,
      ),
    );
  }
  const field = <A>(
    key: string,
    decode: (value: unknown) => Option.Option<A>,
    empty: A,
    expected: string,
  ): A => {
    if (raw[key] === undefined) return empty;
    return Option.getOrElse(decode(raw[key]), () => {
      issues.push(issue("invalid_definition", null, key, `"${key}" must be ${expected}.`));
      return empty;
    });
  };
  return {
    definition: {
      name: directoryName,
      projects: field("projects", decodeNames, [], "a list of project names"),
      triggers: field(
        "triggers",
        decodeTriggers,
        [],
        'a list of { "kind": "scheduled_task", "scheduledTaskId": "..." }',
      ),
      roles: field(
        "roles",
        decodeRoles,
        {},
        "an object mapping foreman, implement, or review to a relative .md path",
      ),
    },
    issues,
  };
}

const encodeDefinition = Schema.encodeSync(FactoryDefinition);
const encodeBinding = Schema.encodeSync(FactoryRoleBinding);

export const renderFactoryJson = (definition: FactoryDefinition) =>
  `${JSON.stringify(encodeDefinition(definition), null, 2)}\n`;

// The empty case is tried first, so an empty frontmatter never takes a body's leading rule.
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/;

const bindingFields: Record<
  keyof FactoryRoleBinding,
  { readonly decode: (value: unknown) => Option.Option<unknown>; readonly expected: string }
> = {
  model: { decode: Schema.decodeUnknownOption(ModelSelection), expected: "{ instanceId, model }" },
  runtimeMode: {
    decode: Schema.decodeUnknownOption(RuntimeMode),
    expected: RuntimeMode.literals.join(", "),
  },
  interactionMode: {
    decode: Schema.decodeUnknownOption(ProviderInteractionMode),
    expected: ProviderInteractionMode.literals.join(", "),
  },
  isolation: {
    decode: Schema.decodeUnknownOption(FactoryIsolation),
    expected: FactoryIsolation.literals.join(", "),
  },
  skills: { decode: decodeNames, expected: "a list of skill names" },
  tools: { decode: decodeNames, expected: "a list of tool names" },
};

const isBindingField = (key: string): key is keyof typeof bindingFields =>
  Object.hasOwn(bindingFields, key);

/**
 * A role file: YAML frontmatter with the bindings, then the instructions. Each binding with the
 * wrong shape, and each unknown key, is reported and left out, so the built-in default applies.
 * A blank body is null, which keeps the built-in instructions.
 */
export function parseRoleFile(
  role: FactoryRoleName,
  text: string,
): {
  readonly binding: FactoryRoleBinding;
  readonly body: string | null;
  readonly issues: ReadonlyArray<FactoryIssue>;
} {
  const match = FRONTMATTER.exec(text);
  const rest = match === null ? text : text.slice(match[0].length);
  const body = rest.trim().length === 0 ? null : rest.trim();
  if (match === null) return { binding: {}, body, issues: [] };

  let raw: unknown;
  try {
    raw = parseYaml(match[1] ?? "");
  } catch {
    return {
      binding: {},
      body,
      issues: [issue("invalid_role_file", role, null, "The frontmatter is not valid YAML.")],
    };
  }
  if (raw === null || raw === undefined) return { binding: {}, body, issues: [] };
  if (!isRecord(raw)) {
    return {
      binding: {},
      body,
      issues: [issue("invalid_role_file", role, null, "The frontmatter must be a YAML mapping.")],
    };
  }
  const issues: Array<FactoryIssue> = [];
  const binding: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isBindingField(key)) {
      issues.push(issue("invalid_binding", role, key, `"${key}" is not a role binding.`));
      continue;
    }
    const { decode, expected } = bindingFields[key];
    const decoded = decode(value);
    if (Option.isNone(decoded)) {
      issues.push(issue("invalid_binding", role, key, `"${key}" must be ${expected}.`));
      continue;
    }
    binding[key] = decoded.value;
  }
  // Each field was decoded by its own schema above.
  return { binding: binding as FactoryRoleBinding, body, issues };
}

/** Always fenced, so a body that opens with a horizontal rule is not read as frontmatter. */
export function renderRoleFile(binding: FactoryRoleBinding, body: string | null): string {
  const encoded = encodeBinding(binding);
  const frontmatter = Object.keys(encoded).length === 0 ? "" : stringifyYaml(encoded);
  const instructions = body?.trim() ?? "";
  return `---\n${frontmatter}---\n${instructions.length === 0 ? "" : `\n${instructions}\n`}`;
}

export const effectiveBinding = (
  defaults: FactoryEffectiveBinding,
  file: FactoryRoleBinding,
): FactoryEffectiveBinding => ({
  model: file.model ?? defaults.model,
  runtimeMode: file.runtimeMode ?? defaults.runtimeMode,
  interactionMode: file.interactionMode ?? defaults.interactionMode,
  isolation: file.isolation ?? defaults.isolation,
  skills: file.skills ?? defaults.skills,
  tools: file.tools ?? defaults.tools,
});

const optionProblem = (
  selection: { readonly id: string; readonly value: string | boolean },
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): string | null => {
  const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
  if (descriptor === undefined) {
    const known = descriptors.map((candidate) => candidate.id).join(", ");
    return `Unknown option ${selection.id}; supported options: ${known || "none"}.`;
  }
  if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
    return `Option ${selection.id} expects true or false.`;
  }
  if (
    descriptor.type === "select" &&
    !descriptor.options.some((choice) => choice.id === selection.value)
  ) {
    const choices = descriptor.options.map((choice) => choice.id).join(", ");
    return `Option ${selection.id} must be one of: ${choices}.`;
  }
  return null;
};

/** Checks a role's effective model and runtime mode against the providers this server runs. */
export function bindingIssues(
  role: FactoryRoleName,
  binding: FactoryEffectiveBinding,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<FactoryIssue> {
  const selection = binding.model;
  if (selection === null) return [];
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) {
    return [
      issue(
        "unknown_provider_instance",
        role,
        "model",
        `No provider instance ${selection.instanceId} is configured here.`,
      ),
    ];
  }
  const issues: Array<FactoryIssue> = [];
  // A provider that lists no models accepts any; this matches delegate_task.
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (provider.models.length > 0 && model === undefined) {
    issues.push(
      issue(
        "unknown_model",
        role,
        "model",
        `${selection.instanceId} does not offer the model ${selection.model}.`,
      ),
    );
  }
  const descriptors = model?.capabilities?.optionDescriptors;
  if (descriptors !== undefined) {
    for (const selected of selection.options ?? []) {
      const problem = optionProblem(selected, descriptors);
      if (problem !== null) issues.push(issue("invalid_model_options", role, "model", problem));
    }
  }
  if (
    provider.supportedRuntimeModes !== undefined &&
    !provider.supportedRuntimeModes.includes(binding.runtimeMode)
  ) {
    issues.push(
      issue(
        "unsupported_runtime_mode",
        role,
        "runtimeMode",
        `${selection.instanceId} does not support the ${binding.runtimeMode} runtime mode.`,
      ),
    );
  }
  return issues;
}

/** Resolves project names against this environment's projects, by exact title. */
export function resolveProjects(
  names: ReadonlyArray<string>,
  projects: ReadonlyArray<{ readonly projectId: ProjectId; readonly title: string }>,
): {
  readonly projects: ReadonlyArray<FactoryProject>;
  readonly issues: ReadonlyArray<FactoryIssue>;
} {
  const issues: Array<FactoryIssue> = [];
  const resolved = names.map((name): FactoryProject => {
    const matches = projects.filter((project) => project.title === name);
    if (matches.length === 1) return { name, projectId: matches[0]!.projectId };
    issues.push(
      matches.length === 0
        ? issue("unknown_project", null, "projects", `No project here is named "${name}".`)
        : issue(
            "ambiguous_project",
            null,
            "projects",
            `${matches.length} projects here are named "${name}". Rename one to use it.`,
          ),
    );
    return { name, projectId: null };
  });
  return { projects: resolved, issues };
}
