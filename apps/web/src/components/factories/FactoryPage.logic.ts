import type {
  Factory,
  FactoryIssue,
  FactoryRole,
  FactoryRoleBinding,
  FactoryRoleChange,
  FactoryRoleName,
  FactorySaveInput,
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
