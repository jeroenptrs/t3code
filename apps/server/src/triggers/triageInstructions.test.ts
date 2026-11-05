import { assert, describe, it } from "@effect/vitest";

import { renderTriageInstructions, type TriageOrigin } from "./triageInstructions.ts";

const EVENT: TriageOrigin = { kind: "event", source: "jira", type: "issue.opened" };

const render = (fallback: "ask" | "label" | "stop", origin: TriageOrigin = EVENT) =>
  renderTriageInstructions({
    taskTitle: "Fix <label> bugs",
    origin,
    triage: fallback === "label" ? { fallback, label: "needs-triage" } : { fallback },
  });

describe("renderTriageInstructions", () => {
  it("keeps only the chosen fallback paragraph", () => {
    const paragraphs = { ask: "Ask. Write", label: "Label and stop.", stop: "Stop. Write" };
    for (const fallback of ["ask", "label", "stop"] as const) {
      const text = render(fallback);
      for (const [other, opening] of Object.entries(paragraphs)) {
        assert.strictEqual(text.includes(`\n\n${opening}`), other === fallback, other);
      }
      assert.notMatch(text, /\[(ask|label|stop)\]/);
      assert.match(text, /^## Triage\n\n/);
      assert.match(text, /keep that message short and specific/);
    }
  });

  it("names the trigger and inserts the label, leaving the title's angle brackets alone", () => {
    const text = render("label");
    assert.include(
      text,
      'Trigger "Fix <label> bugs" fired on a Jira event of type `issue.opened` because',
    );
    assert.include(text, "Add the label `needs-triage` to the item");
    assert.include(text, "`<trigger-data-…>`");
  });

  it.each([
    ["webhook", { kind: "webhook" }, "fired on a webhook request", "`<webhook-data-…>`"],
    ["schedule", { kind: "schedule" }, "ran because its time came", "there is no event data"],
    [
      "manual",
      { kind: "manual" },
      'started task "Fix <label> bugs" by hand',
      "there is no event data",
    ],
  ] as const)("opens a %s run with what started it", (_kind, origin, started, item) => {
    const text = render("stop", origin);
    assert.include(text, started);
    assert.include(text, item);
    assert.notInclude(text, "every filter on it matched");
  });
});
