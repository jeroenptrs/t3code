import type { FactoryEffectiveBinding, FactoryRoleName } from "@t3tools/contracts";

import * as analysis from "./analysis.ts";
import * as foreman from "./foreman.ts";
import * as implement from "./implement.ts";
import * as review from "./review.ts";

interface RoleDefaults {
  readonly binding: FactoryEffectiveBinding;
  readonly description: string;
  readonly body: string;
}

/**
 * Built-in roles. A factory's role of a preset's name layers its file over the preset; the
 * Foreman always does.
 */
export const rolePresets = {
  foreman: { binding: foreman.binding, description: foreman.description, body: foreman.body },
  implement: {
    binding: implement.binding,
    description: implement.description,
    body: implement.body,
  },
  review: { binding: review.binding, description: review.description, body: review.body },
  analysis: { binding: analysis.binding, description: analysis.description, body: analysis.body },
} satisfies Record<string, RoleDefaults>;

/** What a role with no preset starts from: the project's model and a worktree of its own. */
const plainRole: RoleDefaults = {
  binding: { ...implement.binding, isolation: "worktree", skills: [] },
  description: "",
  body: "",
};

/** What a role gets when its factory has no role file, or the file leaves a binding out. */
export const roleDefaults = (role: FactoryRoleName): RoleDefaults =>
  Object.hasOwn(rolePresets, role) ? rolePresets[role as keyof typeof rolePresets] : plainRole;
