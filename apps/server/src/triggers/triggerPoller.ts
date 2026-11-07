import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScheduledTaskPoller from "../scheduledTasks/ScheduledTaskPoller.ts";
import * as GitLabProjectsPoller from "./gitlabProjectsPoller.ts";
import * as JiraQueryPoller from "./jiraQueryPoller.ts";

/** The one poller port, by the polled trigger's source. */
export const layer = Layer.effect(
  ScheduledTaskPoller.ScheduledTaskPoller,
  Effect.gen(function* () {
    const jira = yield* JiraQueryPoller.make;
    const gitlab = yield* GitLabProjectsPoller.make;
    return ScheduledTaskPoller.ScheduledTaskPoller.of({
      poll: Effect.fn("TriggerPoller.poll")(function* (task, options) {
        return yield* task.schedule.type === "gitlab_projects"
          ? gitlab.poll(task, options)
          : jira.poll(task, options);
      }),
    });
  }),
);
