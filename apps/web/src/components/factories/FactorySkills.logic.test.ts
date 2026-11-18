import { describe, expect, it } from "vite-plus/test";

import { skillDeleteMessage, skillTemplate, withSkillName } from "./FactorySkills.logic";

describe("withSkillName", () => {
  it.each([
    [skillTemplate("lint"), "run-checks", skillTemplate("run-checks")],
    // Only the frontmatter's name changes, not a line in the instructions.
    ["---\nname: a\n---\nname: keep\n", "b", "---\nname: b\n---\nname: keep\n"],
    ["---\ndescription: x\n---\nname: keep\n", "b", "---\ndescription: x\n---\nname: keep\n"],
    ["No frontmatter.\nname: keep\n", "b", "No frontmatter.\nname: keep\n"],
  ])("sets the frontmatter name of %j to %s", (body, name, expected) => {
    expect(withSkillName(body, name)).toBe(expected);
  });
});

describe("skillDeleteMessage", () => {
  it.each([
    ["factory", "home", "The home skill of that name applies instead."],
    ["home", "builtin", "The built-in skill of that name applies instead."],
    ["factory", null, "Roles that bind lint then go without it."],
  ] as const)("names what applies after a %s skill over %s goes", (source, replaces, after) => {
    const message = skillDeleteMessage({ name: "lint", source, description: "", replaces });
    expect(message.split("\n")[1]).toBe(after);
  });
});
