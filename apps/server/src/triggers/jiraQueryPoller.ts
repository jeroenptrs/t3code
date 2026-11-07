import { type JiraIssueSummary, type ScheduledTask, ScheduledTaskError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as JiraApi from "../jira/JiraApi.ts";
import * as JiraIdentities from "../jira/JiraIdentities.ts";
import { summaryFields, toIssueSummary } from "../jira/issueMapping.ts";
import * as ScheduledTaskPoller from "../scheduledTasks/ScheduledTaskPoller.ts";
import { jiraQueryWatchedFields } from "./jiraTriggerSource.ts";
import * as TriggerSources from "./TriggerSources.ts";

const PAGE_SIZE = 100;
const MAX_ISSUES = 500;
// Sprints and story points are not watched, so the poll skips the field lookup they need.
const NO_CUSTOM_FIELDS = { sprint: null, storyPoints: null };
const isScheduledTaskError = Schema.is(ScheduledTaskError);

export const make = Effect.gen(function* () {
  const api = yield* JiraApi.JiraApi;
  const identities = yield* JiraIdentities.JiraIdentities;
  const sources = yield* TriggerSources.TriggerSources;

  /**
   * One poll of a Jira query trigger, always as the site's configured service identity and never
   * through the read cache. A saved filter's JQL is read on every poll, so edits to it apply.
   */
  const pollJiraQuery = Effect.fn("jiraQueryPoller.pollJiraQuery")(
    function* (task: ScheduledTask) {
      const { schedule } = task;
      if (schedule.type !== "jira_query") return;
      const identity = yield* identities.forSite(schedule.site);
      let jql = schedule.jql;
      let query = schedule.jql ?? "";
      if (schedule.filterId !== undefined) {
        const filter = yield* api.getFilter(identity, schedule.filterId);
        if (filter.jql === undefined) {
          return yield* new ScheduledTaskError({
            message: `Jira returned no JQL for the saved filter ${filter.name}.`,
            taskId: task.id,
          });
        }
        jql = filter.jql;
        query = filter.name;
      }
      if (jql === undefined) return;
      const issues: Array<JiraIssueSummary> = [];
      let nextPageToken: string | undefined;
      let complete = false;
      for (let page = 0; page < MAX_ISSUES / PAGE_SIZE; page += 1) {
        const result = yield* api.searchJql(identity, {
          jql,
          fields: summaryFields(NO_CUSTOM_FIELDS),
          maxResults: PAGE_SIZE,
          nextPageToken,
        });
        for (const issue of result.issues ?? []) {
          issues.push(toIssueSummary(issue, { site: identity.site, fieldIds: NO_CUSTOM_FIELDS }));
        }
        nextPageToken = result.nextPageToken ?? undefined;
        if (nextPageToken === undefined) {
          complete = true;
          break;
        }
      }
      yield* Effect.annotateCurrentSpan({
        "scheduled_task.id": task.id,
        "jira.site": identity.site,
        "jira.issues": issues.length,
        "jira.complete": complete,
      });
      yield* sources.observeJiraQuery({
        triggerId: task.id,
        query,
        issues: issues.slice(0, MAX_ISSUES),
        watchedFields: jiraQueryWatchedFields(schedule.filters ?? []),
        complete,
      });
    },
    (effect, task) =>
      effect.pipe(
        Effect.mapError((error) =>
          isScheduledTaskError(error)
            ? error
            : new ScheduledTaskError({ message: error.message, taskId: task.id, cause: error }),
        ),
      ),
  );

  return ScheduledTaskPoller.ScheduledTaskPoller.of({ poll: pollJiraQuery });
});

export const layer = Layer.effect(ScheduledTaskPoller.ScheduledTaskPoller, make);
