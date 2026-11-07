import { Atom } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  FactoryId,
  ProjectId,
  type Factory,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { FactoryDefinitionSection } from "./FactoryDefinitionSection";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project-api");
const factory = {
  id: FactoryId.make("factory:project-api:nightly-triage"),
  projectId,
  name: "nightly-triage",
} as Factory;

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: "connected" },
    serverConfig: {
      environment: { platform: "linux", capabilities: { scheduledTaskThreadModes: true } },
    },
  };
}

vi.mock(import("../settings/SettingsScopeContext"), async (original) => ({
  ...(await original()),
  SettingsScopeProvider: (({ children }: { children: ReactNode }) => children) as never,
  useSettingsScope: (() => ({
    scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
    environments: [environment()],
    connectedEnvironments: [environment()],
    environment: environment(),
    target: null,
    targets: [],
  })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const allowed = Atom.make(true);
  const providers = Atom.make([]);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: () => allowed,
      },
      providersValueAtom: (() => providers) as never,
    },
  };
});
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  // Mirrors the real query: a null request has no data.
  useEnvironmentQuery: ((request: unknown) => ({
    data: request === null ? null : { tasks: [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => environment()) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "API" }]) as never,
}));
vi.mock(import("../../state/factories"), async (original) => ({
  ...(await original()),
  useFactoryEnvironments: (() => [
    { environmentId, factories: [factory], canManage: true },
  ]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

it("opens Add trigger on the factory's project, creating its work items", async () => {
  await using screen = await render(
    <FactoryDefinitionSection
      environmentId={environmentId}
      factory={factory}
      projects={[]}
      triggers={[]}
      editable
      disabled={false}
      issues={[]}
      onProjectsChange={() => {}}
      onTriggersChange={() => {}}
      onTriggerCreated={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Add trigger" }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByLabelText("Project")).toHaveTextContent("API");
  await expect
    .element(dialog.getByLabelText("Destination"))
    .toHaveTextContent("Work item in factory");
  await expect.element(dialog.getByLabelText("Factory")).toHaveTextContent("nightly-triage");
});
