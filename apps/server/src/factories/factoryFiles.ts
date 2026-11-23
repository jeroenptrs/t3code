/**
 * The factory definition files: parsing them into what the service reports, rendering them back,
 * resolving role skills, and checking role bindings against the provider catalog. Pure functions,
 * apart from reading one level's skill directories; the services do the rest of the I/O.
 */
import {
  FACTORY_FOREMAN_ROLE,
  FactoryDefinition,
  type FactoryEffectiveBinding,
  FactoryIsolation,
  type FactoryIssue,
  FactoryName,
  FactoryRoleBinding,
  FactoryRoleDescription,
  FactoryRoleName,
  FactoryRolePath,
  type FactorySkill,
  FactorySkillName,
  type FactorySkillSource,
  isReservedFactoryRoleName,
  ModelSelection,
  ProviderInteractionMode,
  type ProviderOptionDescriptor,
  RuntimeMode,
  type ServerProvider,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { builtinSkills } from "./skills/index.ts";

/** Where factories live in a project's checkout. */
export const FACTORIES_DIRECTORY = [".t3", "factories"] as const;

export const FACTORY_FILE_NAME = "factory.json";

export const defaultRolePath = (role: FactoryRoleName) => `roles/${role}.md`;

/** A factory's and T3 home's skills are `skills/<name>/SKILL.md`, beside any supporting files. */
export const SKILLS_DIRECTORY = "skills";

export const SKILL_FILE_NAME = "SKILL.md";

const issue = (
  code: FactoryIssue["code"],
  role: FactoryRoleName | null,
  field: string | null,
  message: string,
): FactoryIssue => ({ code, role, field, message });

const decodeName = Schema.decodeUnknownOption(FactoryName);
const isSkillName = Schema.is(FactorySkillName);
const decodeNames = Schema.decodeUnknownOption(Schema.Array(TrimmedNonEmptyString));
const isRoleName = Schema.is(FactoryRoleName);
const decodeRolePath = Schema.decodeUnknownOption(FactoryRolePath);

/** Roles a `factory.json` without a version has, whether it lists them or not. */
const LEGACY_ROLES = [FACTORY_FOREMAN_ROLE, "implement", "review"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const emptyDefinition = (name: string): FactoryDefinition => ({ version: 2, name, roles: {} });

/** Why `name` cannot name a role, or null when it can. */
export function roleNameProblem(name: string): string | null {
  if (!isRoleName(name)) {
    return `"${name}" is not a role name: use lowercase letters, digits, and single hyphens, at most 64 characters.`;
  }
  if (isReservedFactoryRoleName(name)) {
    return `"${name}" cannot name a role, since a work item stage has that name.`;
  }
  return null;
}

/** The factory's roles in order: the Foreman, then the definition's. */
export const factoryRoleNames = (definition: FactoryDefinition): ReadonlyArray<FactoryRoleName> => [
  FACTORY_FOREMAN_ROLE,
  ...Object.keys(definition.roles).filter((role) => role !== FACTORY_FOREMAN_ROLE),
];

/**
 * `factory.json` in the directory `directoryName`, whose name wins over the file's. A field with
 * the wrong shape is reported and read as empty, and a bad role is reported and left out. A file
 * without `version` has implement and review too, and each legacy role it does not list takes
 * `roles/<role>.md` when `hasDefaultRoleFile` says it exists.
 */
export function parseFactoryJson(
  directoryName: string,
  text: string,
  hasDefaultRoleFile: (role: string) => boolean = () => false,
): {
  readonly definition: FactoryDefinition;
  readonly issues: ReadonlyArray<FactoryIssue>;
  /** What the retired `projects` field names, for the service to compare with its own project. */
  readonly listedProjects: ReadonlyArray<string>;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      definition: emptyDefinition(directoryName),
      issues: [issue("invalid_definition", null, null, `${FACTORY_FILE_NAME} is not valid JSON.`)],
      listedProjects: [],
    };
  }
  if (!isRecord(raw)) {
    return {
      definition: emptyDefinition(directoryName),
      issues: [issue("invalid_definition", null, null, `${FACTORY_FILE_NAME} must be an object.`)],
      listedProjects: [],
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
  const legacy = raw.version === undefined;
  if (!legacy && raw.version !== 2) {
    issues.push(issue("invalid_definition", null, "version", `"version" must be 2.`));
  }
  const roles: Record<string, FactoryRolePath | null> = {};
  if (raw.roles !== undefined && !isRecord(raw.roles)) {
    issues.push(
      issue(
        "invalid_definition",
        null,
        "roles",
        `"roles" must be an object mapping each role name to a relative .md path, or to null.`,
      ),
    );
  }
  for (const [role, value] of Object.entries(isRecord(raw.roles) ? raw.roles : {})) {
    const problem = roleNameProblem(role);
    if (problem !== null) {
      issues.push(issue("invalid_definition", null, "roles", problem));
      continue;
    }
    if (value === null && !legacy) {
      roles[role] = null;
      continue;
    }
    const rolePath = decodeRolePath(value);
    if (Option.isNone(rolePath)) {
      issues.push(
        issue(
          "invalid_definition",
          role,
          "roles",
          `The path for ${role} must be a relative .md path inside the factory directory${legacy ? "" : ", or null"}.`,
        ),
      );
      continue;
    }
    roles[role] = rolePath.value;
  }
  if (legacy) {
    for (const role of LEGACY_ROLES) {
      if (roles[role] !== undefined) continue;
      const hasFile = hasDefaultRoleFile(role);
      // The Foreman is a role without being listed.
      if (role === FACTORY_FOREMAN_ROLE && !hasFile) continue;
      roles[role] = hasFile ? defaultRolePath(role) : null;
    }
  }
  return {
    definition: { version: 2, name: directoryName, roles },
    issues,
    listedProjects: Option.getOrElse(decodeNames(raw.projects), () => []),
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
  enabled: { decode: Schema.decodeUnknownOption(Schema.Boolean), expected: "true or false" },
  description: {
    decode: Schema.decodeUnknownOption(FactoryRoleDescription),
    expected: "one line of at most 200 characters",
  },
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
 * wrong shape, and each unknown key, is reported and left out, so the role's default applies.
 * A blank body is null, which keeps the default instructions.
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

/**
 * Whether a role with this file binding is enabled, and the issue when the file tries to disable
 * the Foreman, which it cannot.
 */
export function roleEnabled(
  role: FactoryRoleName,
  file: FactoryRoleBinding,
): { readonly enabled: boolean; readonly issue: FactoryIssue | null } {
  if (role !== FACTORY_FOREMAN_ROLE) return { enabled: file.enabled !== false, issue: null };
  return {
    enabled: true,
    issue:
      file.enabled === false
        ? issue(
            "invalid_binding",
            role,
            "enabled",
            "The Foreman cannot be disabled, so its enabled: false is ignored.",
          )
        : null,
  };
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

/**
 * A SKILL.md: the frontmatter's `name` and `description`, and what follows it. `problem` says why
 * a provider would not load it: no frontmatter, or one that is not a YAML mapping.
 */
export function parseSkillFile(text: string): {
  readonly name: string | null;
  readonly description: string;
  readonly body: string;
  readonly problem: string | null;
} {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    return { name: null, description: "", body: text, problem: "SKILL.md has no frontmatter." };
  }
  const body = text.slice(match[0].length);
  let raw: unknown;
  try {
    raw = parseYaml(match[1] ?? "");
  } catch {
    return { name: null, description: "", body, problem: "The frontmatter is not valid YAML." };
  }
  if (!isRecord(raw)) {
    return {
      name: null,
      description: "",
      body,
      problem: "The frontmatter must be a YAML mapping with name and description.",
    };
  }
  return {
    name: typeof raw.name === "string" ? raw.name.trim() : null,
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    body,
    problem: null,
  };
}

/** A skill where it lives: a built-in SKILL.md's text, or a directory that holds a SKILL.md. */
export type SkillEntry = FactorySkill &
  (
    | { readonly source: "builtin"; readonly text: string }
    | { readonly source: Exclude<FactorySkillSource, "builtin">; readonly directory: string }
  );

export const builtinSkillEntries: ReadonlyArray<SkillEntry> = Object.entries(builtinSkills).map(
  ([name, text]) => ({
    name,
    source: "builtin",
    description: parseSkillFile(text).description,
    replaces: null,
    text,
  }),
);

const ifExists = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
  effect.pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

/** A role and its file, null when `factory.json` names none or the named file does not exist. */
export interface RoleFileEntry {
  readonly role: FactoryRoleName;
  readonly path: string | null;
  readonly file: ReturnType<typeof parseRoleFile> | null;
}

/** `factory.json` in `directory` and the file of each role it has; none without `factory.json`. */
export const readFactoryFiles = Effect.fn("factoryFiles.readFactoryFiles")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  name: string,
) {
  const text = yield* ifExists(fileSystem.readFileString(path.join(directory, FACTORY_FILE_NAME)));
  if (Option.isNone(text)) return Option.none();
  const defaultFiles = Option.getOrElse(
    yield* ifExists(fileSystem.readDirectory(path.join(directory, "roles"))),
    (): ReadonlyArray<string> => [],
  );
  const { definition, issues, listedProjects } = parseFactoryJson(name, text.value, (role) =>
    defaultFiles.includes(`${role}.md`),
  );
  const roles = yield* Effect.forEach(factoryRoleNames(definition), (role) =>
    Effect.gen(function* () {
      const rolePath = definition.roles[role] ?? null;
      if (rolePath === null) return { role, path: null, file: null } satisfies RoleFileEntry;
      const roleText = yield* ifExists(fileSystem.readFileString(path.join(directory, rolePath)));
      return {
        role,
        path: rolePath,
        file: Option.isNone(roleText) ? null : parseRoleFile(role, roleText.value),
      } satisfies RoleFileEntry;
    }),
  );
  return Option.some({ definition, issues, listedProjects, roles });
});

/** The skill directories under `skillsDirectory` that hold a SKILL.md, sorted. */
export const readSkillLevel = Effect.fn("factoryFiles.readSkillLevel")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  skillsDirectory: string,
  source: Exclude<FactorySkillSource, "builtin">,
) {
  const entries = Option.getOrElse(
    yield* ifExists(fileSystem.readDirectoryEntries(skillsDirectory)),
    () => [],
  );
  const names = entries
    .filter((entry) => entry.type !== "File" && isSkillName(entry.name))
    .map((entry) => entry.name)
    .toSorted();
  const skills: Array<SkillEntry> = [];
  for (const name of names) {
    const directory = path.join(skillsDirectory, name);
    const text = yield* ifExists(fileSystem.readFileString(path.join(directory, SKILL_FILE_NAME)));
    if (Option.isNone(text)) continue;
    skills.push({
      name,
      source,
      description: parseSkillFile(text.value).description,
      replaces: null,
      directory,
    });
  }
  return skills;
});

/**
 * One skill per name, sorted: each level, lowest first, replaces a lower one's skill whole, and the
 * skill notes the level it replaced.
 */
export function resolveSkills(
  levels: ReadonlyArray<ReadonlyArray<SkillEntry>>,
): ReadonlyArray<SkillEntry> {
  const byName = new Map<string, SkillEntry>();
  for (const level of levels) {
    for (const skill of level) {
      byName.set(skill.name, { ...skill, replaces: byName.get(skill.name)?.source ?? null });
    }
  }
  return [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export const toFactorySkill = ({
  name,
  source,
  description,
  replaces,
}: FactorySkill): FactorySkill => ({ name, source, description, replaces });

/** The skills a role's binding names that exist, in its order, and an issue for each that does not. */
export function resolveRoleSkills<Skill extends FactorySkill>(
  role: FactoryRoleName,
  names: ReadonlyArray<string>,
  available: ReadonlyArray<Skill>,
): { readonly skills: ReadonlyArray<Skill>; readonly issues: ReadonlyArray<FactoryIssue> } {
  const skills: Array<Skill> = [];
  const issues: Array<FactoryIssue> = [];
  for (const name of new Set(names)) {
    const skill = available.find((candidate) => candidate.name === name);
    if (skill !== undefined) {
      skills.push(skill);
      continue;
    }
    issues.push(
      issue(
        "unknown_skill",
        role,
        "skills",
        `No skill ${name} exists: it is not built in, and neither the factory nor T3 home has ${SKILLS_DIRECTORY}/${name}/${SKILL_FILE_NAME}.`,
      ),
    );
  }
  return { skills, issues };
}

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
  if (!provider.enabled) {
    issues.push(
      issue(
        "disabled_provider_instance",
        role,
        "model",
        `${selection.instanceId} is turned off in this environment's provider settings.`,
      ),
    );
  }
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

/**
 * `projects` once named other projects a factory could work in, though no agent ever read it. A
 * factory now works in what its own project covers, so a list that names another project gets
 * this issue, and the next save drops the field.
 */
export function otherProjectsIssue(
  listed: ReadonlyArray<string>,
  ownProjectTitle: string,
): FactoryIssue | null {
  const others = listed.filter((name) => name !== ownProjectTitle);
  if (others.length === 0) return null;
  return issue(
    "other_projects",
    null,
    "projects",
    `${FACTORY_FILE_NAME} lists ${others.map((name) => `"${name}"`).join(", ")} under "projects", which factories no longer read. A factory works in the repositories its own project covers: add another repository's folder under the project's Repositories settings. The next save drops the field.`,
  );
}
