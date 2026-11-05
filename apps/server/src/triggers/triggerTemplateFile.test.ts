import { describe, expect, it } from "@effect/vitest";
import type { TriggerTemplate } from "@t3tools/contracts";
import * as Result from "effect/Result";

import { formatTriggerTemplateFile, parseTriggerTemplateFile } from "./triggerTemplateFile.ts";

const DESIGN_EXAMPLE = `---
title: Issue enters In Progress
source: jira
filters:
  - path: event.type
    op: equals
    value: issue.status_changed
  - path: event.status
    op: equals
    value: "{{status}}"
placeholders:
  - name: status
    description: The Jira status that starts work
    default: In Progress
---
Work on Jira issue {{event.key}}: {{event.summary}} ({{event.url}}).
`;

describe("trigger template files", () => {
  it("parses a template file", () => {
    expect(parseTriggerTemplateFile("issue-in-progress", DESIGN_EXAMPLE)).toEqual(
      Result.succeed({
        name: "issue-in-progress",
        title: "Issue enters In Progress",
        source: "jira",
        filters: [
          { path: "event.type", op: "equals", value: "issue.status_changed" },
          { path: "event.status", op: "equals", value: "{{status}}" },
        ],
        placeholders: [
          {
            name: "status",
            description: "The Jira status that starts work",
            default: "In Progress",
          },
        ],
        prompt: "Work on Jira issue {{event.key}}: {{event.summary}} ({{event.url}}).",
      }),
    );
  });

  it("reads YAML numbers and booleans as strings", () => {
    const parsed = parseTriggerTemplateFile(
      "numbers",
      "---\ntitle: Numbers\nsource: webhook\nfilters:\n  - path: body.count\n    op: in\n    value: [1, true]\n---\n\nPrompt\n",
    );
    expect(Result.map(parsed, (template) => [template.filters, template.prompt])).toEqual(
      Result.succeed([[{ path: "body.count", op: "in", value: ["1", "true"] }], "Prompt"]),
    );
  });

  it("formats a template that parses back to itself", () => {
    const template: TriggerTemplate = {
      name: "mr-pipeline",
      title: "Pipeline: failed",
      source: "gitlab",
      filters: [
        { path: "event.type", op: "in", value: ["pipeline.failed", "{{other}}"] },
        { path: "event.headBranch", op: "exists" },
        { path: "event.baseBranch", op: "equals", value: "true" },
      ],
      placeholders: [{ name: "other" }],
      prompt: "---\nFix {{event.url}}.\n\n# Notes\nKeep it small.",
    };
    expect(parseTriggerTemplateFile(template.name, formatTriggerTemplateFile(template))).toEqual(
      Result.succeed(template),
    );
    const bare = { ...template, filters: [], placeholders: [] };
    expect(parseTriggerTemplateFile(bare.name, formatTriggerTemplateFile(bare))).toEqual(
      Result.succeed(bare),
    );
  });

  it.each([
    ["no frontmatter", "Just a prompt\n", "no YAML frontmatter"],
    ["bad YAML", "---\ntitle: [\n---\nPrompt\n", "not valid YAML"],
    ["a list frontmatter", "---\n- a\n---\nPrompt\n", "must be a YAML mapping"],
    ["an unknown source", "---\ntitle: T\nsource: email\n---\nPrompt\n", '["source"]'],
    [
      "a filter without a value",
      "---\ntitle: T\nsource: jira\nfilters:\n  - path: event.type\n    op: equals\n---\nPrompt\n",
      '["filters"][0]["value"]',
    ],
  ])("names the problem in a file with %s", (_case, contents, problem) => {
    const parsed = parseTriggerTemplateFile("bad", contents);
    expect(Result.isFailure(parsed) && parsed.failure).toContain(problem);
  });
});
