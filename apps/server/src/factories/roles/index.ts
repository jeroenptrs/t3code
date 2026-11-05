import type { FactoryEffectiveBinding, FactoryRoleName } from "@t3tools/contracts";

import * as foreman from "./foreman.ts";
import * as implement from "./implement.ts";
import * as review from "./review.ts";

/** What a role gets when its factory has no role file, or the file leaves a binding out. */
export const builtinRoles = {
  foreman: { binding: foreman.binding, body: foreman.body },
  implement: { binding: implement.binding, body: implement.body },
  review: { binding: review.binding, body: review.body },
} satisfies Record<
  FactoryRoleName,
  { readonly binding: FactoryEffectiveBinding; readonly body: string }
>;
