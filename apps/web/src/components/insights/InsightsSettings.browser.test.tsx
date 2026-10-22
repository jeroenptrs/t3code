import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  InsightsContributorId,
  ProjectId,
  type InsightsConfig,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  config: null as InsightsConfig | null,
  calls: [] as Array<readonly [string, unknown]>,
}));

// The real module builds atoms on the app's connection runtime, which tries to reach a server.
vi.mock(import("../../state/insights"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const config = Atom.make(() => AsyncResult.success(state.config!));
  const allowed = Atom.make(true);
  const command = (label: string) => ({ label, permissionAtom: () => allowed });
  return {
    insightsEnvironment: {
      config: (() => config) as never,
      refresh: () => undefined,
      updateSettings: command("updateSettings") as never,
      setProjectEnabled: command("setProjectEnabled") as never,
      rescanProject: command("rescanProject") as never,
      updateContributor: command("updateContributor") as never,
      mergeContributors: command("mergeContributors") as never,
    } as never,
    useInsightsAccess: () => ({ loaded: true, canRead: true, canManage: true }),
    useInsightsEnvironmentId: () => EnvironmentId.make("env"),
  };
});
// The real page container reads scope and layout state from live environments.
vi.mock(import("../settings/settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) => async (value: unknown) => {
    state.calls.push([command.label, value]);
    return { _tag: "Success", value: state.config };
  }) as never,
}));

import { InsightsSettingsPanel } from "./InsightsSettings";

const environmentId = EnvironmentId.make("env");

function setup() {
  state.calls = [];
  state.config = {
    settings: {
      startDate: "2026-07-01",
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
        enabled: false,
        syncedThrough: null,
        lastSyncAt: null,
        lastError: null,
      },
    ],
    contributors: [
      {
        contributorId: InsightsContributorId.make("ada"),
        displayName: "Ada Lovelace",
        status: "pending",
        kind: "human",
        userId: null,
        gitlabLogin: "ada",
        emails: ["ada@example.com"],
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        decidedAt: null,
      },
      {
        contributorId: InsightsContributorId.make("bea"),
        displayName: "Bea",
        status: "included",
        kind: "human",
        userId: null,
        gitlabLogin: null,
        emails: ["bea@example.com"],
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        decidedAt: "2026-10-02T00:00:00.000Z",
      },
    ],
  };
}

const panel = () => (
  <RegistryProvider>
    <InsightsSettingsPanel environmentId={environmentId} />
  </RegistryProvider>
);

it("turns a project on without asking, since nothing is deleted", async () => {
  setup();
  await using screen = await render(panel());
  const toggle = screen.getByRole("switch", { name: "Read api" });
  await expect.element(toggle).not.toBeChecked();
  // Browser tests load no app stylesheet, so the unstyled switch has no box a pointer can hit.
  await act(() => (toggle.element() as HTMLElement).click());
  await vi.waitFor(() =>
    expect(state.calls).toEqual([
      ["setProjectEnabled", { environmentId, input: { projectId: "project-api", enabled: true } }],
    ]),
  );
});

it("lists pending people apart from included ones and includes one", async () => {
  setup();
  await using screen = await render(panel());
  await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
  await expect.element(screen.getByText("Bea")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Include" }));
  await vi.waitFor(() =>
    expect(state.calls).toEqual([
      ["updateContributor", { environmentId, input: { contributorId: "ada", status: "included" } }],
    ]),
  );

  await userEvent.click(page.getByRole("button", { name: /^Included \(/ }));
  await expect.element(screen.getByText("Bea")).toBeVisible();
  await expect.element(screen.getByText("Ada Lovelace")).not.toBeInTheDocument();
});
