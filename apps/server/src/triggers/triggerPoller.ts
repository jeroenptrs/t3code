import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScheduledTaskPoller from "../scheduledTasks/ScheduledTaskPoller.ts";
import * as GitLabProjectsPoller from "./gitlabProjectsPoller.ts";
import * as JiraQueryPoller from "./jiraQueryPoller.ts";
import * as NeutralPoller from "./neutralPoller.ts";

/** The one poller port, by the polled trigger's source. */
export const layer = Layer.effect(
  ScheduledTaskPoller.ScheduledTaskPoller,
  Effect.gen(function* () {
    const jira = yield* JiraQueryPoller.make;
    const gitlab = yield* GitLabProjectsPoller.make;
    const neutral = yield* NeutralPoller.make;
    return ScheduledTaskPoller.ScheduledTaskPoller.of({
      poll: Effect.fn("TriggerPoller.poll")(function* (task, options) {
        switch (task.schedule.type) {
          case "gitlab_projects":
            return yield* gitlab.poll(task, options);
          case "issues":
          case "pull_requests":
            return yield* neutral.poll(task, options);
          default:
            return yield* jira.poll(task, options);
        }
      }),
    });
  }),
);
