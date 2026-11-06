import type {
  Factory,
  FactoryIssue,
  FactoryRole,
  FactoryRoleBinding,
  FactoryRoleChange,
  FactoryRoleName,
  FactorySaveInput,
  FactorySkill,
  FactorySkillLevel,
  FactorySkillSource,
  ScheduledTaskId,
} from "@t3tools/contracts";

/** One role as the form edits it: the role file's own bindings, never the built-in ones. */
export interface FactoryRoleDraft {
  readonly binding: Omit<FactoryRoleBinding, "skills" | "tools">;
  /** Comma-separated. Blank leaves the list to the built-in role. */
  readonly skills: string;
  readonly tools: string;
  readonly body: string;
  /** "Use built-in instructions": the save deletes the role file. */
  readonly useBuiltin: boolean;
}

export interface FactoryDraft {
  readonly projects: ReadonlyArray<string>;
  readonly triggers: ReadonlyArray<ScheduledTaskId>;
  readonly roles: Readonly<Record<FactoryRoleName, FactoryRoleDraft>>;
}

const BINDING_KEYS = ["model", "runtimeMode", "interactionMode", "isolation"] as const;

function factoryRoleDraft(role: FactoryRole): FactoryRoleDraft {
  const { skills, tools, ...binding } = role.fileBinding;
  return {
    binding,
    skills: (skills ?? []).join(", "),
    tools: (tools ?? []).join(", "),
    body: role.body,
    useBuiltin: false,
  };
}

export function factoryDraft(factory: Factory): FactoryDraft {
  const roles = Object.fromEntries(
    factory.roles.map((role) => [role.role, factoryRoleDraft(role)]),
  ) as Record<FactoryRoleName, FactoryRoleDraft>;
  return {
    projects: factory.definition.projects,
    triggers: factory.definition.triggers.map((trigger) => trigger.scheduledTaskId),
    roles,
  };
}

/** Comma-separated names, trimmed, without blanks or repeats. */
function parseNameList(text: string): ReadonlyArray<string> {
  return [
    ...new Set(
      text
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    ),
  ];
}

function sameRoleDraft(left: FactoryRoleDraft, right: FactoryRoleDraft): boolean {
  return (
    left.useBuiltin === right.useBuiltin &&
    left.body === right.body &&
    parseNameList(left.skills).join("\n") === parseNameList(right.skills).join("\n") &&
    parseNameList(left.tools).join("\n") === parseNameList(right.tools).join("\n") &&
    BINDING_KEYS.every(
      (key) => JSON.stringify(left.binding[key]) === JSON.stringify(right.binding[key]),
    )
  );
}

function roleChange(role: FactoryRole, edited: FactoryRoleDraft): FactoryRoleChange | null {
  if (sameRoleDraft(edited, factoryRoleDraft(role))) return null;
  if (edited.useBuiltin) return role.source === "file" ? { role: role.role, file: null } : null;
  const skills = parseNameList(edited.skills);
  const tools = parseNameList(edited.tools);
  // A built-in body the person left alone stays built-in, so later default changes reach it.
  const keepsBuiltinBody =
    edited.body.trim() === "" || (role.bodySource === "builtin" && edited.body === role.body);
  return {
    role: role.role,
    file: {
      binding: {
        ...edited.binding,
        ...(skills.length > 0 ? { skills } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      },
      body: keepsBuiltinBody ? null : edited.body,
    },
  };
}

/** The one save the form sends: the definition as edited, and a file change per edited role. */
export function buildFactorySaveInput(factory: Factory, draft: FactoryDraft): FactorySaveInput {
  const roles = factory.roles.flatMap((role) => {
    const change = roleChange(role, draft.roles[role.role]);
    return change === null ? [] : [change];
  });
  return {
    projectId: factory.projectId,
    definition: {
      name: factory.name,
      projects: draft.projects,
      triggers: draft.triggers.map((scheduledTaskId) => ({
        kind: "scheduled_task" as const,
        scheduledTaskId,
      })),
      roles: factory.definition.roles,
    },
    ...(roles.length > 0 ? { roles } : {}),
  };
}

export function factoryDraftChanged(factory: Factory, draft: FactoryDraft): boolean {
  const input = buildFactorySaveInput(factory, draft);
  return (
    input.roles !== undefined ||
    input.definition.projects.join("\n") !== factory.definition.projects.join("\n") ||
    draft.triggers.join("\n") !==
      factory.definition.triggers.map((trigger) => trigger.scheduledTaskId).join("\n")
  );
}

/** The issues a refused save or a read reported for one field, to show beside it. */
export function issuesFor(
  issues: ReadonlyArray<FactoryIssue>,
  role: FactoryRoleName | null,
  field: string | null,
): ReadonlyArray<FactoryIssue> {
  return issues.filter((issue) => issue.role === role && issue.field === field);
}

export const SKILL_SOURCE_LABEL: Readonly<Record<FactorySkillSource, string>> = {
  builtin: "Built-in",
  home: "Home",
  factory: "This factory",
};

/** A new SKILL.md: the frontmatter a provider loads it by, then room for the instructions. */
export const skillTemplate = (name: string) => `---\nname: ${name}\ndescription: \n---\n\n`;

const SKILL_FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** `body` with its frontmatter `name` set to `name`; unchanged when the frontmatter has none. */
export function withSkillName(body: string, name: string): string {
  const frontmatter = SKILL_FRONTMATTER.exec(body)?.[0];
  if (frontmatter === undefined) return body;
  return frontmatter.replace(/^name:[^\r\n]*/m, `name: ${name}`) + body.slice(frontmatter.length);
}

/**
 * The levels an edit of `skill` can save at, the default first. A built-in or home skill saves as
 * a copy in this factory unless the person picks home, so editing never lands somewhere unseen.
 */
export function skillSaveLevels(source: FactorySkillSource): ReadonlyArray<FactorySkillLevel> {
  return source === "factory" ? ["factory"] : ["factory", "home"];
}

/** What the delete confirmation asks, with what a role that binds the skill gets afterwards. */
export function skillDeleteMessage(skill: FactorySkill): string {
  const question =
    skill.source === "home"
      ? `Delete the home skill ${skill.name}? Every factory on this server that has no ${skill.name} of its own loses it.`
      : `Delete this factory's skill ${skill.name}?`;
  const after =
    skill.replaces === null
      ? `Roles that bind ${skill.name} then go without it.`
      : `The ${skill.replaces === "home" ? "home" : "built-in"} skill of that name applies instead.`;
  return `${question}\n${after}`;
}
