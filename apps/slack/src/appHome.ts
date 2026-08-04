import * as NodeCrypto from "node:crypto";

import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type {
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { buildEnvironmentDeepLink, buildThreadDeepLink } from "@t3tools/integration-runtime";

// Slack currently permits 100 blocks in a Home tab view. Keep the platform
// constraint here so row capacity follows Block Kit rather than product config.
// https://docs.slack.dev/reference/block-kit/blocks/
export const SLACK_HOME_MAX_BLOCKS = 100;
export const APP_HOME_VIEW_ALL_ACTION = "t3_view_all_tasks";

const TEXT_MAX = 180;
const PROJECT_TEXT_MAX = 80;

export interface AppHomeTask {
  readonly thread: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly status: string;
}

export interface AppHomeTaskSelection {
  readonly tasks: ReadonlyArray<AppHomeTask>;
  readonly nextSnoozeWakeAt: string | null;
}

const taskStatus = (thread: OrchestrationThreadShell): string => {
  if (thread.hasPendingApprovals) return "Pending approval";
  if (thread.hasPendingUserInput) return "Awaiting input";
  if (thread.session?.status === "starting") return "Connecting";
  if (thread.session?.status === "running") return "Working";
  if (thread.session?.status === "error") return "Failed";
  if (
    thread.interactionMode === "plan" &&
    thread.latestTurn?.startedAt != null &&
    thread.latestTurn.completedAt != null &&
    thread.hasActionableProposedPlan
  ) {
    return "Plan ready";
  }
  return "Ready";
};

const validTimestamp = (value: string | null | undefined): number | null => {
  if (value == null) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
};

const compareThreadIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Temporary Slice 3 projection: App Home omits server-explicit settled work
 * unless a pending approval or user-input blocker must remain visible. The
 * intended later shape remains an unsettled-first list with a settled tail.
 */
export function selectAppHomeTasks(
  snapshot: OrchestrationShellSnapshot,
  options: { readonly now: string },
): AppHomeTaskSelection {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const tasks: AppHomeTask[] = [];
  let nextSnoozeWakeAt: string | null = null;
  let nextSnoozeWakeAtMs = Number.POSITIVE_INFINITY;

  for (const thread of snapshot.threads) {
    if (thread.archivedAt !== null) continue;
    if (
      thread.settledOverride === "settled" &&
      !thread.hasPendingApprovals &&
      !thread.hasPendingUserInput
    ) {
      continue;
    }
    if (effectiveSnoozed(thread, options)) {
      const wakeAtMs = validTimestamp(thread.snoozedUntil);
      if (wakeAtMs !== null && wakeAtMs < nextSnoozeWakeAtMs) {
        nextSnoozeWakeAt = thread.snoozedUntil ?? null;
        nextSnoozeWakeAtMs = wakeAtMs;
      }
      continue;
    }
    const project = projects.get(thread.projectId);
    if (!project) continue;
    tasks.push({ thread, project, status: taskStatus(thread) });
  }

  tasks.sort(
    (left, right) =>
      (validTimestamp(right.thread.createdAt) ?? 0) -
        (validTimestamp(left.thread.createdAt) ?? 0) ||
      compareThreadIds(left.thread.id, right.thread.id),
  );

  return { tasks, nextSnoozeWakeAt };
}

export interface AppHomeView {
  readonly type: "home";
  readonly blocks: ReadonlyArray<Record<string, unknown>>;
}

const appHomeChrome = (environmentUrl: string) =>
  [
    {
      type: "header",
      text: { type: "plain_text", text: "Welcome to T3 Code" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "Active conversations across all projects" },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View all tasks" },
          url: environmentUrl,
          action_id: APP_HOME_VIEW_ALL_ACTION,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Active conversations*" },
    },
    { type: "divider" },
  ] as const;

const cleanText = (value: string, maxLength: number): string => {
  const singleLine = value.replaceAll(/\s+/g, " ").trim();
  const characters = [...singleLine];
  const truncated =
    characters.length > maxLength
      ? `${characters.slice(0, maxLength - 3).join("")}...`
      : singleLine;
  return truncated
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "¦");
};

export function buildAppHomeView(input: {
  readonly tasks: ReadonlyArray<AppHomeTask>;
  readonly publicBaseUrl: string;
  readonly environmentId: string;
}): AppHomeView {
  const environmentUrl = buildEnvironmentDeepLink(input);
  const chrome = appHomeChrome(environmentUrl);

  if (input.tasks.length === 0) {
    return {
      type: "home",
      blocks: [
        ...chrome,
        {
          type: "section",
          text: { type: "mrkdwn", text: "_No active conversations right now._" },
        },
      ],
    };
  }

  const maximumRowsWithoutFooter = SLACK_HOME_MAX_BLOCKS - chrome.length;
  const truncated = input.tasks.length > maximumRowsWithoutFooter;
  const rowCapacity = SLACK_HOME_MAX_BLOCKS - chrome.length - (truncated ? 1 : 0);
  const visibleTasks = input.tasks.slice(0, rowCapacity);
  const rows = visibleTasks.map(({ thread, project, status }) => {
    const threadUrl = buildThreadDeepLink({
      publicBaseUrl: input.publicBaseUrl,
      environmentId: input.environmentId,
      threadId: thread.id,
    });
    return {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${threadUrl}|${cleanText(thread.title, TEXT_MAX)}>*\nStatus: *${cleanText(status, TEXT_MAX)}*    Project: *${cleanText(project.title, PROJECT_TEXT_MAX)}*`,
      },
    };
  });
  const footer = truncated
    ? [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Showing the newest ${visibleTasks.length} of ${input.tasks.length} active tasks · <${environmentUrl}|View all in T3 Code>`,
            },
          ],
        },
      ]
    : [];

  return { type: "home", blocks: [...chrome, ...rows, ...footer] };
}

const viewHash = (view: AppHomeView): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(view)).digest("hex");

export interface AppHomePublisher {
  readonly opened: (userId: string, snapshot: OrchestrationShellSnapshot | null) => Promise<void>;
  readonly updated: (snapshot: OrchestrationShellSnapshot) => void;
  readonly stop: () => Promise<void>;
}

export async function resolveAppHomeOpenSnapshot(input: {
  readonly getSnapshot: () => OrchestrationShellSnapshot | null;
  readonly refresh: () => Promise<unknown>;
  readonly onRefreshError?: (error: unknown) => void;
}): Promise<OrchestrationShellSnapshot | null> {
  try {
    await input.refresh();
  } catch (error) {
    input.onRefreshError?.(error);
  }
  // The live stream can publish while the HTTP refresh is pending. Its current
  // value is authoritative regardless of whether that refresh succeeded.
  return input.getSnapshot();
}

export function makeAppHomePublisher(input: {
  readonly publicBaseUrl: string;
  readonly resolveEnvironmentId: () => Promise<string>;
  readonly publish: (userId: string, view: AppHomeView) => Promise<void>;
  readonly debounceMs?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, userId: string | null) => void;
}): AppHomePublisher {
  const knownUsers = new Set<string>();
  const publishedHashes = new Map<string, string>();
  const publicationQueues = new Map<string, Promise<void>>();
  const debounceMs = input.debounceMs ?? 250;
  const now = input.now ?? (() => new Date());
  let environmentId: Promise<string> | null = null;
  let snapshot: OrchestrationShellSnapshot | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let livePublishPromise: Promise<void> | null = null;
  let livePublishPending = false;
  let renderRevision = 0;
  let renderCache: {
    readonly revision: number;
    readonly result: Promise<{ readonly view: AppHomeView; readonly hash: string }>;
  } | null = null;
  let stopped = false;

  const invalidateRender = (): void => {
    renderRevision += 1;
    renderCache = null;
  };

  const reportError = (error: unknown, userId: string | null): void => {
    try {
      input.onError?.(error, userId);
    } catch {
      // Diagnostics must not interfere with other users' publications.
    }
  };

  const getEnvironmentId = (): Promise<string> => {
    environmentId ??= input.resolveEnvironmentId().catch((error: unknown) => {
      environmentId = null;
      throw error;
    });
    return environmentId;
  };

  const unavailableView = (): AppHomeView => ({
    type: "home",
    blocks: [
      ...appHomeChrome(input.publicBaseUrl),
      {
        type: "section",
        text: { type: "mrkdwn", text: "_T3 Code tasks are temporarily unavailable._" },
      },
    ],
  });

  const renderCurrent = (): Promise<{ readonly view: AppHomeView; readonly hash: string }> => {
    if (renderCache?.revision === renderRevision) return renderCache.result;
    const revision = renderRevision;
    const result = (async () => {
      let view: AppHomeView;
      if (snapshot === null) {
        view = unavailableView();
      } else {
        let resolvedEnvironmentId: string;
        try {
          resolvedEnvironmentId = await getEnvironmentId();
        } catch (error) {
          reportError(error, null);
          if (revision !== renderRevision) return renderCurrent();
          view = unavailableView();
          return { view, hash: viewHash(view) };
        }
        if (revision !== renderRevision) return renderCurrent();
        const selection = selectAppHomeTasks(snapshot, { now: now().toISOString() });
        view = buildAppHomeView({
          tasks: selection.tasks,
          publicBaseUrl: input.publicBaseUrl,
          environmentId: resolvedEnvironmentId,
        });
      }
      return { view, hash: viewHash(view) };
    })();
    renderCache = { revision, result };
    return result;
  };

  const publishForUser = async (userId: string, force: boolean): Promise<void> => {
    try {
      const { view, hash } = await renderCurrent();
      if (stopped) return;
      if (!force && publishedHashes.get(userId) === hash) return;
      await input.publish(userId, view);
      if (!stopped) publishedHashes.set(userId, hash);
    } catch (error) {
      reportError(error, userId);
    }
  };

  const enqueuePublish = (userId: string, force: boolean): Promise<void> => {
    const previous = publicationQueues.get(userId) ?? Promise.resolve();
    const queued = previous.then(() => publishForUser(userId, force));
    publicationQueues.set(userId, queued);
    void queued.finally(() => {
      if (publicationQueues.get(userId) === queued) publicationQueues.delete(userId);
    });
    return queued;
  };

  const publishLive = async (): Promise<void> => {
    // Avoid turning one shell burst into a Slack API burst for every observed
    // user. Per-user failures are already isolated by publishForUser.
    await Promise.allSettled([...knownUsers].map((userId) => enqueuePublish(userId, false)));
  };

  const requestLivePublish = (): void => {
    if (stopped) return;
    if (livePublishPromise !== null) {
      livePublishPending = true;
      return;
    }
    livePublishPromise = (async () => {
      while (true) {
        livePublishPending = false;
        await publishLive();
        if (!livePublishPending || stopped) break;
      }
    })().finally(() => {
      livePublishPromise = null;
    });
  };

  const scheduleLivePublish = (): void => {
    if (stopped || knownUsers.size === 0 || debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      requestLivePublish();
    }, debounceMs);
  };

  const scheduleWake = (): void => {
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    wakeTimer = null;
    if (stopped || snapshot === null || knownUsers.size === 0) return;
    const currentTime = now();
    const selection = selectAppHomeTasks(snapshot, { now: currentTime.toISOString() });
    if (selection.nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(selection.nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - currentTime.getTime()) + 50, 2_147_483_647);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      invalidateRender();
      scheduleLivePublish();
      scheduleWake();
    }, delayMs);
  };

  return {
    opened: async (userId, nextSnapshot) => {
      if (stopped) return;
      knownUsers.add(userId);
      if (
        nextSnapshot !== null &&
        (snapshot === null || nextSnapshot.snapshotSequence >= snapshot.snapshotSequence)
      ) {
        snapshot = nextSnapshot;
        invalidateRender();
      }
      scheduleWake();
      await enqueuePublish(userId, true);
    },
    updated: (nextSnapshot) => {
      if (stopped) return;
      snapshot = nextSnapshot;
      invalidateRender();
      scheduleWake();
      scheduleLivePublish();
    },
    stop: async () => {
      stopped = true;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (wakeTimer !== null) clearTimeout(wakeTimer);
      debounceTimer = null;
      wakeTimer = null;
      knownUsers.clear();
      publishedHashes.clear();
      renderCache = null;
      livePublishPending = false;
      const pending = [...publicationQueues.values()];
      if (livePublishPromise !== null) pending.push(livePublishPromise);
      await Promise.allSettled(pending);
      publicationQueues.clear();
    },
  };
}
