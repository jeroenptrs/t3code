import {
  EnvironmentId,
  InsightsContributorId,
  ProjectId,
  type InsightsConfig,
  type InsightsOverview,
  type InsightsOverviewInput,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  inputs: [] as Array<unknown>,
  overview: null as InsightsOverview | null,
  config: null as InsightsConfig | null,
}));

// The real module builds atoms on the app's connection runtime, which tries to reach a server.
vi.mock(import("../../state/insights"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const overview = Atom.make(() => AsyncResult.success(state.overview!));
  const config = Atom.make(() => AsyncResult.success(state.config!));
  return {
    insightsEnvironment: {
      overview: ((target: { readonly input: unknown }) => {
        state.inputs.push(target.input);
        return overview;
      }) as never,
      config: (() => config) as never,
      refresh: () => undefined,
    } as never,
    useInsightsAccess: () => ({ loaded: true, canRead: true, canManage: false }),
    useInsightsEnvironmentId: () => EnvironmentId.make("env"),
  };
});

import { INSIGHTS_CHARTS, parseInsightsSearch } from "./insights.logic";
import { InsightsPage } from "./InsightsPage";
import { InsightsChartView, InsightsOverviewView } from "./InsightsViews";

const ada = InsightsContributorId.make("ada");
const bob = InsightsContributorId.make("bob");
const spread = (median: number | null) => ({ median, p85: median });
const byType = (feat: number) => ({ feat, fix: 0, chore: 0, docs: 0, test: 0, other: 0 });

function setup() {
  state.inputs = [];
  const contributor = (contributorId: InsightsContributorId, displayName: string) => ({
    contributorId,
    displayName,
    status: "included" as const,
    kind: "human" as const,
    userId: null,
    gitlabLogin: null,
    emails: [],
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    decidedAt: "2026-09-01T00:00:00.000Z",
  });
  state.config = {
    settings: {
      startDate: "2026-01-01",
      releaseBranchPatterns: [],
      requestBudgetPerTick: 20,
      updatedAt: null,
    },
    projects: [
      {
        projectId: ProjectId.make("project-api"),
        title: "api",
        host: "gitlab.example.com",
        repository: "team/api",
        enabled: true,
        syncedThrough: null,
        lastSyncAt: null,
        lastError: null,
      },
    ],
    contributors: [contributor(ada, "Ada"), contributor(bob, "Bob")],
  };
  const row = (contributorId: InsightsContributorId, displayName: string) => ({
    contributorId,
    displayName,
    kind: "human" as const,
    pushedHours: 10,
    landedHours: 8,
    landedShare: 0.8,
    throughput: 0.5,
    commits: 3,
    mergeRequestsMerged: 2,
    reviewsGiven: 1,
    medianFirstReviewHours: 2,
    medianCycleHours: 20,
  });
  const weekStarts = ["2026-09-07", "2026-09-14"];
  state.overview = {
    from: "2026-09-07",
    to: "2026-09-20",
    workingDays: 10,
    weeks: weekStarts.map((weekStart) => ({
      weekStart,
      pushedHours: 10,
      landedHours: 8,
      activeContributors: 2,
    })),
    contributors: [row(ada, "Ada"), row(bob, "Bob")],
    byContributorWeeks: [
      { weekStart: "2026-09-07", contributorId: ada, pushedHours: 5, landedHours: 4 },
    ],
    cycle: {
      weeks: weekStarts.map((weekStart) => ({
        weekStart,
        count: 1,
        coding: spread(10),
        pickup: spread(2),
        review: spread(5),
        toTrunk: spread(1),
      })),
      contributors: [],
    },
    leadTime: {
      weeks: weekStarts.map((weekStart) => ({ weekStart, count: 1, medianDays: 2, p85Days: 3 })),
      contributors: [],
    },
    size: {
      buckets: [
        {
          min: 0,
          max: 49,
          count: 2,
          medianChangedFiles: 1,
          medianFirstReviewHours: 1.5,
          byContributor: [{ contributorId: ada, count: 2 }],
        },
        {
          min: 50,
          max: 200,
          count: 0,
          medianChangedFiles: null,
          medianFirstReviewHours: null,
          byContributor: [],
        },
      ],
    },
    mix: {
      contributors: [{ contributorId: ada, hoursByType: byType(4), commitsByType: byType(1) }],
      weeks: weekStarts.map((weekStart) => ({
        weekStart,
        hoursByType: byType(2),
        commitsByType: byType(1),
      })),
    },
    reviews: {
      cells: [
        { reviewerContributorId: bob, authorContributorId: ada, count: 2, mergeRequests: [4, 9] },
      ],
      unreviewedMergesByAuthor: [{ contributorId: ada, merged: 2, unreviewed: 0 }],
    },
    headline: {
      leadTimeMedianDays: 2,
      medianMergeRequestLines: 30,
      unreviewedMergeShare: 0,
      agentAssistedShare: 0.25,
      abandonedShare: null,
    },
  };
}

/** The Insights routes as the app declares them, without the app shell around them. */
function insightsRouter(path: string) {
  const root = createRootRoute();
  const insights = createRoute({
    getParentRoute: () => root,
    path: "insights",
    validateSearch: parseInsightsSearch,
    component: InsightsPage,
  });
  return createRouter({
    routeTree: root.addChildren([
      insights.addChildren([
        createRoute({ getParentRoute: () => insights, path: "/", component: InsightsOverviewView }),
        createRoute({
          getParentRoute: () => insights,
          path: "$chart",
          component: InsightsChartView,
        }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
}

const renderAt = async (path: string) => {
  const router = insightsRouter(path);
  // The test brings its own router: the default one renders a fixed tree with no Insights routes.
  const screen = await render(<RouterProvider router={router} />, { router: false });
  return { screen, router };
};

const heading = (name: string) => page.getByRole("heading", { level: 1, name, exact: true });

it("opens each chart from the overview and comes back", async () => {
  setup();
  const { screen } = await renderAt("/insights");
  await using _screen = screen;
  for (const chart of INSIGHTS_CHARTS) {
    await userEvent.click(page.getByRole("link", { name: `Expand ${chart.title}` }));
    await expect.element(heading(chart.title)).toBeVisible();
    await userEvent.click(page.getByRole("link", { name: "Insights", exact: true }));
    await expect.element(heading("Insights")).toBeVisible();
  }
});

it("shows a slot's numbers while hovered and hides them on leave", async () => {
  setup();
  const { screen } = await renderAt("/insights/size");
  await using _screen = screen;
  const firstBucket = page.elementLocator(
    screen.container.querySelector('[data-slot="chart-hit"]')!,
  );
  await userEvent.hover(firstBucket);
  await expect.element(page.getByRole("tooltip").getByText("<50 lines: 2 merged")).toBeVisible();
  await userEvent.hover(heading("Merge request size"));
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
});

it("keeps the window and contributor filter from the URL across views", async () => {
  setup();
  const search = `?from=2026-09-01&to=2026-09-30&contributors=${encodeURIComponent(JSON.stringify(["ada"]))}`;
  const { screen, router } = await renderAt(`/insights${search}`);
  await using _screen = screen;
  const expected: InsightsOverviewInput = {
    from: "2026-09-01",
    to: "2026-09-30",
    contributorIds: [ada],
  };
  await expect.element(page.getByLabelText("From")).toHaveValue("2026-09-01");
  await expect.element(page.getByRole("button", { name: "Ada" })).toBeVisible();
  expect(state.inputs.at(-1)).toEqual(expected);

  await userEvent.click(page.getByRole("link", { name: "Expand Cycle time" }));
  await expect.element(heading("Cycle time")).toBeVisible();
  expect(router.state.location.search).toEqual({
    from: "2026-09-01",
    to: "2026-09-30",
    contributors: ["ada"],
  });
  expect(state.inputs.at(-1)).toEqual(expected);
  await expect.element(page.getByLabelText("To")).toHaveValue("2026-09-30");

  await userEvent.click(page.getByRole("link", { name: "Insights", exact: true }));
  await expect.element(heading("Insights")).toBeVisible();
  expect(router.state.location.search).toEqual({
    from: "2026-09-01",
    to: "2026-09-30",
    contributors: ["ada"],
  });
});
