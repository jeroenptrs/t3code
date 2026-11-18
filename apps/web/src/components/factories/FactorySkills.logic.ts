import type { FactorySkill, FactorySkillLevel, FactorySkillSource } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export const SKILL_SOURCE_LABEL: Readonly<Record<FactorySkillSource, string>> = {
  builtin: msg("Built-in", { $context: "a skill that ships with T3 Code" }),
  home: msg("Home", { $context: "a skill saved for every project on this server" }),
  factory: msg("This factory", { $context: "a skill saved in this factory" }),
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

/** What the delete confirmation says goes, and what a role that binds the skill gets after. */
export function skillDeleteMessage(skill: FactorySkill, resolve: MessageResolver = m): string {
  const what =
    skill.source === "home"
      ? resolve(
          msg(
            "Every factory on this server without its own {name} skill loses the home skill {name}.",
            { name: skill.name },
          ),
        )
      : resolve(msg("This deletes this factory's skill {name}.", { name: skill.name }));
  const after =
    skill.replaces === null
      ? resolve(msg("Roles that bind {name} then go without it.", { name: skill.name }))
      : skill.replaces === "home"
        ? resolve(msg("The home skill of that name applies instead."))
        : resolve(msg("The built-in skill of that name applies instead."));
  return `${what}\n${after}`;
}
