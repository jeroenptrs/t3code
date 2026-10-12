import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";

import * as TextGenerationOperations from "./textGenerationOperations.ts";

const walkthroughInput = {
  cwd: "/tmp/checkout",
  subject: "branch feature/search",
  baseCommit: "abc123",
  hasCommitHistory: true,
  stat: " src/search.ts | 1 +",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
};

describe("fromRunner", () => {
  it.effect("investigates for a walkthrough and drops the fields the model left empty", () =>
    Effect.gen(function* () {
      const requests: Array<TextGenerationOperations.Request<never>> = [];
      const generation = TextGenerationOperations.fromRunner("Test", (request) => {
        requests.push(request as TextGenerationOperations.Request<never>);
        return Effect.succeed({
          summary: "  ",
          groups: [
            {
              id: "search",
              title: "Search",
              summary: "Adds search.",
              attention: null,
              files: [
                { path: "src/search.ts", note: "" },
                { path: "src/index.ts", note: " re-export " },
              ],
              questions: [],
            },
          ],
          notes: [
            {
              groupId: "search",
              path: "src/search.ts",
              side: "new",
              start: 1,
              end: 1,
              summary: "Adds the query.",
              body: "",
            },
          ],
        } as never);
      });
      const result = yield* generation.generateDiffWalkthrough(walkthroughInput);
      assert.strictEqual(requests[0]?.operation, "generateDiffWalkthrough");
      assert.isDefined(requests[0]?.investigate);
      assert.deepStrictEqual(result, {
        groups: [
          {
            id: "search",
            title: "Search",
            summary: "Adds search.",
            attention: null,
            files: [{ path: "src/search.ts" }, { path: "src/index.ts", note: "re-export" }],
            questions: [],
          },
        ],
        notes: [
          {
            groupId: "search",
            path: "src/search.ts",
            side: "new",
            start: 1,
            end: 1,
            summary: "Adds the query.",
          },
        ],
      });
    }),
  );

  it.effect("refuses a walkthrough on a runner with no read-only tool mode", () =>
    Effect.gen(function* () {
      const generation = TextGenerationOperations.fromRunner(
        "Test",
        TextGenerationOperations.withoutInvestigation("Cursor", () =>
          Effect.die("a refused investigation must not reach the model"),
        ),
      );
      const error = yield* Effect.flip(generation.generateDiffWalkthrough(walkthroughInput));
      assert.strictEqual(error.operation, "generateDiffWalkthrough");
      assert.include(error.detail, "Cursor cannot investigate a checkout read-only");
      assert.include(error.detail, "guide and walkthrough model");
      // Known up front, so a caller refuses before preparing a checkout.
      assert.strictEqual(generation.investigationRefusal, error.detail);
    }),
  );
});
