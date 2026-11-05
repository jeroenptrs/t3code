import * as implement from "./implement.ts";
import * as review from "./review.ts";

/** Each built-in skill's SKILL.md, by name. A factory's own skill of the same name replaces it. */
export const builtinSkills: Readonly<Record<string, string>> = {
  implement: implement.skill,
  review: review.skill,
};
