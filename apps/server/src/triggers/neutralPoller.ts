import { type ScheduledTask, ScheduledTaskError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IssueService from "../issue/IssueService.ts";
import { JiraActingUser } from "../jira/JiraActingUser.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { issueTriggerState, pullRequestTriggerState } from "./neutralTriggerSource.ts";
import * as TriggerSources from "./TriggerSources.ts";

// Per tracker scope or repository; the newest by update, so a capped read still sees changes.
const LIST_LIMIT = 100;
const isScheduledTaskError = Schema.is(ScheduledTaskError);

/**
 * Polls an issues or pull requests trigger through the same services the Issues and Pull
 * requests pages read, so every tracker and host the trigger's project is connected to works.
 */
export const make = Effect.gen(function* () {
  const issues = yield* IssueService.IssueService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const sources = yield* TriggerSources.TriggerSources;

  /** A listing answers with what it could read. One that read nothing failed. */
  const requireSome = Effect.fn("neutralPoller.requireSome")(function* <A>(
    task: ScheduledTask,
    noun: string,
    result: {
      readonly entries: ReadonlyArray<A>;
      readonly errors: ReadonlyArray<{ readonly message: string }>;
    },
  ) {
    const [problem] = result.errors;
    if (problem === undefined) return result.entries;
    if (result.entries.length === 0) {
      return yield* new ScheduledTaskError({
        message: `Could not list ${noun}: ${problem.message}`,
        taskId: task.id,
      });
    }
    yield* Effect.logWarning(`A trigger read some of its project's ${noun}`, {
      taskId: task.id,
      errors: result.errors.map((error) => error.message),
    });
    return result.entries;
  });

  const poll = Effect.fn("neutralPoller.poll")(
    function* (task: ScheduledTask, options?: { readonly fireCurrent?: boolean }) {
      const { schedule } = task;
      const fireCurrent = options?.fireCurrent === true;
      if (schedule.type === "issues") {
        const labels = schedule.labels?.toSorted() ?? [];
        const result = yield* issues
          .list({
            projectId: task.projectId,
            state: "all",
            sort: "updated",
            limit: LIST_LIMIT,
            ...(schedule.query === undefined ? {} : { query: schedule.query }),
            ...(labels.length === 0 ? {} : { labels }),
          })
          // A poll never reads as a person: Jira answers as the site's service identity.
          .pipe(Effect.provideService(JiraActingUser, null));
        const entries = yield* requireSome(task, "issues", result);
        yield* sources.observeNeutral({
          source: "issues",
          triggerId: task.id,
          start: schedule.start ?? "changes",
          fireCurrent,
          scope: JSON.stringify([task.projectId, schedule.query ?? null, labels]),
          items: entries.map(issueTriggerState),
        });
        return;
      }
      if (schedule.type === "pull_requests") {
        const result = yield* pullRequests.list({
          projectId: task.projectId,
          state: "all",
          limit: LIST_LIMIT,
          ...(schedule.query === undefined ? {} : { query: schedule.query }),
        });
        const entries = yield* requireSome(task, "pull requests", result);
        yield* sources.observeNeutral({
          source: "pull_requests",
          triggerId: task.id,
          start: schedule.start ?? "changes",
          fireCurrent,
          scope: JSON.stringify([task.projectId, schedule.query ?? null]),
          items: entries.map(pullRequestTriggerState),
        });
      }
    },
    (effect, task, _options?: { readonly fireCurrent?: boolean }) =>
      effect.pipe(
        Effect.mapError((error) =>
          isScheduledTaskError(error)
            ? error
            : new ScheduledTaskError({ message: error.message, taskId: task.id, cause: error }),
        ),
      ),
  );

  return { poll };
});
