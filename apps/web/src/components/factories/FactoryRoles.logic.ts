import {
  FACTORY_FOREMAN_ROLE,
  FactoryRoleName,
  isReservedFactoryRoleName,
  type Factory,
  type FactoryRole,
  type FactoryRoleBinding,
  type FactoryRoleChange,
  type FactoryRolePreset,
  type FactorySaveInput,
} from "@t3tools/contracts";
import { factorySaveInput } from "@t3tools/client-runtime/factories";
import * as Schema from "effect/Schema";

/** The bindings the role page and the Foreman card edit. The rest of the file is kept as read. */
export type RoleBindingDraft = Pick<
  FactoryRoleBinding,
  "model" | "runtimeMode" | "interactionMode" | "isolation"
>;

/** One role as its page edits it. */
export interface RoleDraft {
  readonly binding: RoleBindingDraft;
  readonly description: string;
  readonly skills: ReadonlyArray<string>;
  readonly body: string;
}

const BINDING_KEYS = ["model", "runtimeMode", "interactionMode", "isolation"] as const;

export function roleDraft(role: FactoryRole): RoleDraft {
  const { model, runtimeMode, interactionMode, isolation } = role.fileBinding;
  return {
    binding: {
      ...(model === undefined ? {} : { model }),
      ...(runtimeMode === undefined ? {} : { runtimeMode }),
      ...(interactionMode === undefined ? {} : { interactionMode }),
      ...(isolation === undefined ? {} : { isolation }),
    },
    description: role.description,
    skills: role.binding.skills,
    body: role.body,
  };
}

const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export function roleDraftChanged(role: FactoryRole, draft: RoleDraft): boolean {
  const read = roleDraft(role);
  return (
    draft.body !== read.body ||
    draft.description !== read.description ||
    !sameList(draft.skills, read.skills) ||
    BINDING_KEYS.some(
      (key) => JSON.stringify(draft.binding[key]) !== JSON.stringify(read.binding[key]),
    )
  );
}

/**
 * The role file the draft saves. `enabled` and `tools` stay as the file has them. Skills,
 * description, and instructions the person left as the preset gave them stay unwritten, so a later
 * preset change still reaches the role.
 */
export function roleFileChange(role: FactoryRole, draft: RoleDraft): FactoryRoleChange {
  const {
    model: _model,
    runtimeMode: _runtimeMode,
    interactionMode: _interactionMode,
    isolation: _isolation,
    skills: fileSkills,
    description: fileDescription,
    ...kept
  } = role.fileBinding;
  const description = draft.description.trim();
  const keepsPresetDescription =
    description === "" || (fileDescription === undefined && description === role.description);
  const writesSkills = fileSkills !== undefined || !sameList(draft.skills, role.binding.skills);
  const keepsPresetBody =
    draft.body.trim() === "" || (role.bodySource === "builtin" && draft.body === role.body);
  return {
    role: role.role,
    file: {
      binding: {
        ...kept,
        ...(keepsPresetDescription ? {} : { description }),
        ...draft.binding,
        ...(writesSkills ? { skills: draft.skills } : {}),
      },
      body: keepsPresetBody ? null : draft.body,
    },
  };
}

const isRoleName = Schema.is(FactoryRoleName);

export type RoleNameError = "empty" | "too_long" | "pattern" | "reserved" | "taken";

export function roleNameError(name: string, factory: Pick<Factory, "roles">): RoleNameError | null {
  const trimmed = name.trim();
  if (trimmed === "") return "empty";
  if (trimmed.length > 64) return "too_long";
  if (!isRoleName(trimmed)) return "pattern";
  if (trimmed === FACTORY_FOREMAN_ROLE || isReservedFactoryRoleName(trimmed)) return "reserved";
  return factory.roles.some((role) => role.role === trimmed) ? "taken" : null;
}

export type RoleStart =
  | { readonly kind: "scratch" }
  | { readonly kind: "preset"; readonly preset: FactoryRolePreset };

/**
 * Adds a role at the end. A preset under its own name gets no file, so it follows the preset; a
 * preset under another name gets a file with the preset's bindings and instructions. A role from
 * scratch starts without a file.
 */
export function addRoleSaveInput(
  factory: Pick<Factory, "projectId" | "definition">,
  name: FactoryRoleName,
  start: RoleStart,
): FactorySaveInput {
  const definition = { roles: { ...factory.definition.roles, [name]: null } };
  if (start.kind === "scratch" || start.preset.name === name) {
    return factorySaveInput(factory, { definition });
  }
  const { model, skills, tools, ...binding } = start.preset.binding;
  return factorySaveInput(factory, {
    definition,
    roles: [
      {
        role: name,
        file: {
          binding: {
            ...binding,
            ...(start.preset.description === "" ? {} : { description: start.preset.description }),
            ...(model === null ? {} : { model }),
            ...(skills.length === 0 ? {} : { skills }),
            ...(tools.length === 0 ? {} : { tools }),
          },
          body: start.preset.body.trim() === "" ? null : start.preset.body,
        },
      },
    ],
  });
}

/** Takes the role out of the definition and deletes its file. */
export function removeRoleSaveInput(
  factory: Pick<Factory, "projectId" | "definition">,
  role: FactoryRoleName,
): FactorySaveInput {
  const { [role]: _removed, ...roles } = factory.definition.roles;
  return factorySaveInput(factory, { definition: { roles }, roles: [{ role, file: null }] });
}

/** The roles that bind a skill by name, in the factory's order. */
export function skillUsers(
  factory: Pick<Factory, "roles">,
  skillName: string,
): ReadonlyArray<FactoryRoleName> {
  return factory.roles
    .filter((role) => role.binding.skills.includes(skillName))
    .map((role) => role.role);
}
