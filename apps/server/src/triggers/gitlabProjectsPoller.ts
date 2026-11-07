import { type ScheduledTask, ScheduledTaskError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { pollScopeKey } from "../scheduledTasks/Schedule.ts";
import * as GitLabProjectsClient from "./gitlabProjectsClient.ts";
import type { GitLabPipelineState } from "./gitlabTriggerSource.ts";
import * as TriggerSources from "./TriggerSources.ts";

const newestOf = (from: string, items: ReadonlyArray<string>) =>
  items.reduce((newest, updatedAt) => (updatedAt > newest ? updatedAt : newest), from);

/**
 * One poll as the host's glab login. Per project: a merge request and a pipeline read since the
 * marker; a group: one merge request read, then pipelines per project it names. A seed reads
 * open merge requests and no pipelines.
 */
export const make = Effect.gen(function* () {
  const client = yield* GitLabProjectsClient.make;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sources = yield* TriggerSources.TriggerSources;

  const poll = Effect.fn("gitlabProjectsPoller.poll")(
    function* (task: ScheduledTask, options?: { readonly fireCurrent?: boolean }) {
      const { schedule } = task;
      if (schedule.type !== "gitlab_projects") return;
      const { host } = schedule;
      const project = yield* projects.get(task.projectId);
      if (Option.isNone(project)) {
        return yield* new ScheduledTaskError({
          message: "The trigger's project no longer exists.",
          taskId: task.id,
        });
      }
      const cwd = project.value.workspaceRoot;
      yield* client.requireLogin({ cwd, host });

      const scope = pollScopeKey(schedule);
      const stored = yield* sources.gitLabProjectsMarker(task.id);
      const resume = stored !== null && stored.scope === scope ? stored.marks : null;
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const marks = new Map<string, string>(Object.entries(resume ?? {}));
      // A seed's marks start at this poll: what it did not record is older than the trigger.
      const advance = (mark: string, from: string | null, updatedAts: ReadonlyArray<string>) =>
        marks.set(mark, from === null ? startedAt : newestOf(from, updatedAts));
      const since = (mark: string) => (resume === null ? null : (resume[mark] ?? null));

      const mergeRequests: Array<GitLabProjectsClient.PolledMergeRequest> = [];
      const pipelines: Array<GitLabPipelineState> = [];
      // Runs inside the poll span, once per project.
      const readPipelines = Effect.fnUntraced(function* (path: string, fallbackMark: string) {
        const mark = `pipelines:${path}`;
        // A seed reads no pipelines. A project a group names for the first time reads from the
        // group's mark.
        const from = resume === null ? null : (resume[mark] ?? resume[fallbackMark] ?? startedAt);
        const read =
          from === null ? [] : yield* client.pipelines({ cwd, host, project: path, since: from });
        pipelines.push(...read);
        advance(
          mark,
          from,
          read.map((pipeline) => pipeline.updatedAt),
        );
      });

      for (const path of schedule.projects) {
        const mark = `merge_requests:${path}`;
        const read = yield* client.mergeRequests({ cwd, host, project: path, since: since(mark) });
        mergeRequests.push(...read);
        advance(
          mark,
          since(mark),
          read.flatMap((entry) => entry.snapshot.updatedAt ?? []),
        );
        yield* readPipelines(path, mark);
      }
      if (schedule.group !== undefined) {
        const mark = `group:${schedule.group}`;
        const read = yield* client.mergeRequests({
          cwd,
          host,
          group: schedule.group,
          since: since(mark),
        });
        mergeRequests.push(...read);
        advance(
          mark,
          since(mark),
          read.flatMap((entry) => entry.snapshot.updatedAt ?? []),
        );
        const listed = new Set(schedule.projects);
        const named = new Set(read.map((entry) => entry.key.repository));
        for (const path of named) {
          if (path !== "" && !listed.has(path)) yield* readPipelines(path, mark);
        }
      }

      // Firing the current set needs every open merge request, not only those changed since the
      // marks; a seed's read already is that.
      const fireCurrent = options?.fireCurrent === true;
      if (fireCurrent && resume !== null) {
        const read = new Set(mergeRequests.map((entry) => entry.key.url));
        const open = [
          ...(yield* Effect.forEach(schedule.projects, (path) =>
            client.mergeRequests({ cwd, host, project: path, since: null }),
          )).flat(),
          ...(schedule.group === undefined
            ? []
            : yield* client.mergeRequests({ cwd, host, group: schedule.group, since: null })),
        ];
        for (const entry of open) {
          if (read.has(entry.key.url)) continue;
          read.add(entry.key.url);
          mergeRequests.push(entry);
        }
      }

      yield* Effect.annotateCurrentSpan({
        "scheduled_task.id": task.id,
        "gitlab.host": host,
        "gitlab.merge_requests": mergeRequests.length,
        "gitlab.pipelines": pipelines.length,
      });
      yield* sources.observeGitLabProjects({
        triggerId: task.id,
        start: schedule.start ?? "changes",
        fireCurrent,
        host,
        marker: { scope, marks: Object.fromEntries(marks) },
        mergeRequests,
        pipelines,
      });
    },
    (effect, task, _options?: { readonly fireCurrent?: boolean }) =>
      effect.pipe(
        Effect.mapError((error) =>
          error._tag === "ScheduledTaskError"
            ? error
            : new ScheduledTaskError({ message: error.message, taskId: task.id, cause: error }),
        ),
      ),
  );

  return { poll };
});
