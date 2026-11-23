import { type JiraIssueSummary, type ScheduledTask, ScheduledTaskError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as JiraApi from "../jira/JiraApi.ts";
import * as JiraIdentities from "../jira/JiraIdentities.ts";
import { summaryFields, toIssueSummary } from "../jira/issueMapping.ts";
import * as ScheduledTaskPoller from "../scheduledTasks/ScheduledTaskPoller.ts";
import {
  type JiraChangeHistory,
  JIRA_ROUND_TRIP_FIELDS,
  type JiraQueryRoundTrip,
  jiraQueryRoundTrips,
  jiraQueryWatchedFields,
  jiraTriggerKey,
} from "./jiraTriggerSource.ts";
import * as TriggerSources from "./TriggerSources.ts";

const PAGE_SIZE = 100;
const MAX_ISSUES = 500;
const MAX_CHANGELOG_PAGES = 10;
// Sprints and story points are not watched, so the poll skips the field lookup they need.
const NO_CUSTOM_FIELDS = { sprint: null, storyPoints: null };
const isScheduledTaskError = Schema.is(ScheduledTaskError);

export const make = Effect.gen(function* () {
  const api = yield* JiraApi.JiraApi;
  const identities = yield* JiraIdentities.JiraIdentities;
  const sources = yield* TriggerSources.TriggerSources;

  /**
   * One poll of a Jira query trigger, as the site's service identity, uncached. A saved filter's
   * JQL is read every poll. Issues in both polls whose `updated` moved get their changelog read,
   * to catch a leave and return in between; a failed read fails the poll before anything is stored.
   */
  const pollJiraQuery = Effect.fn("jiraQueryPoller.pollJiraQuery")(
    function* (task: ScheduledTask, options?: { readonly fireCurrent?: boolean }) {
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
      const idsByKey = new Map<string, string>();
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
          idsByKey.set(issue.key, issue.id);
        }
        nextPageToken = result.nextPageToken ?? undefined;
        if (nextPageToken === undefined) {
          complete = true;
          break;
        }
      }
      const observed = issues.slice(0, MAX_ISSUES);
      const stored = yield* sources.jiraQueryObservations(task.id);
      const moved =
        stored.query === query
          ? observed.flatMap((issue) => {
              const previous = stored.issues.get(jiraTriggerKey(issue.site, issue.key));
              const id = idsByKey.get(issue.key);
              return previous === undefined ||
                id === undefined ||
                previous.updated === null ||
                previous.updated === issue.updated
                ? []
                : [{ id, previous, issue }];
            })
          : [];
      const roundTrips = new Map<string, ReadonlyArray<JiraQueryRoundTrip>>();
      if (moved.length > 0) {
        const histories = new Map<string, Array<JiraChangeHistory>>();
        let changelogToken: string | undefined;
        for (let page = 0; page < MAX_CHANGELOG_PAGES; page += 1) {
          const result = yield* api.bulkChangelog(identity, {
            issueIdsOrKeys: moved.map(({ id }) => id),
            fieldIds: JIRA_ROUND_TRIP_FIELDS,
            nextPageToken: changelogToken,
          });
          for (const log of result.issueChangeLogs) {
            const list = histories.get(log.issueId) ?? [];
            list.push(...log.changeHistories);
            histories.set(log.issueId, list);
          }
          changelogToken = result.nextPageToken ?? undefined;
          if (changelogToken === undefined) break;
        }
        for (const { id, previous, issue } of moved) {
          const trips = jiraQueryRoundTrips(previous, issue, histories.get(id) ?? [], jql);
          if (trips.length > 0) roundTrips.set(issue.key, trips);
        }
      }
      yield* Effect.annotateCurrentSpan({
        "scheduled_task.id": task.id,
        "jira.site": identity.site,
        "jira.issues": issues.length,
        "jira.complete": complete,
        "jira.changelogs": moved.length,
      });
      yield* sources.observeJiraQuery({
        triggerId: task.id,
        start: schedule.start ?? "changes",
        fireCurrent: options?.fireCurrent === true,
        query,
        issues: observed,
        watchedFields: jiraQueryWatchedFields(schedule.filters ?? []),
        complete,
        roundTrips,
      });
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

  return ScheduledTaskPoller.ScheduledTaskPoller.of({ poll: pollJiraQuery });
});

export const layer = Layer.effect(ScheduledTaskPoller.ScheduledTaskPoller, make);
