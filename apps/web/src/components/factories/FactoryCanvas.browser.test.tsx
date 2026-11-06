import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  FactoryId,
  ProjectId,
  ThreadId,
  WorkItemId,
  type Factory,
  type WorkItemSummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { FactoryCanvas } from "./FactoryCanvas";

const fixture = vi.hoisted(() => ({
  factory: null as unknown,
  items: [] as unknown[],
  shells: [] as unknown[],
}));

vi.mock("../../state/factories", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const read = Atom.make(() => AsyncResult.success(fixture.factory));
  const workItems = Atom.make(() => AsyncResult.success({ workItems: fixture.items }));
  return { factoriesEnvironment: { read: () => read, workItems: () => workItems } };
});
vi.mock("../../state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const tasks = Atom.make(AsyncResult.initial());
  return { serverEnvironment: { scheduledTasksLive: () => tasks } };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const threadShellsAtom = Atom.make(() => fixture.shells);
  return { environmentThreadShells: { threadShellsAtom } };
});

const environmentId = EnvironmentId.make("environment-local");
const factoryId = FactoryId.make("factory:project-api:nightly");
const implementer = ThreadId.make("thread-implement");

function setup() {
  fixture.factory = {
    id: factoryId,
    projectId: ProjectId.make("project-api"),
    scheduledTaskIds: [],
    threads: [{ threadId: implementer, role: "implement" }],
  } satisfies Partial<Factory>;
  fixture.items = [
    {
      id: WorkItemId.make("work-item:1"),
      title: "Fix the login redirect",
      source: { kind: "manual", text: "" },
      stage: "implement",
      foremanThreadId: null,
      threads: [{ threadId: implementer, role: "implement" }],
    } satisfies Partial<WorkItemSummary>,
  ];
  fixture.shells = [
    {
      environmentId,
      id: implementer,
      runtime: { status: "running", activeRunId: null },
      branch: "t3/fix-login",
      linkedPullRequest: null,
      branchPullRequest: null,
    } as unknown as EnvironmentThreadShell,
  ];
}

it("lights the running implement node and the edge its work item moves on", async () => {
  setup();
  await using screen = await render(
    <AppAtomRegistryProvider>
      <FactoryCanvas environmentId={environmentId} factoryId={factoryId} />
    </AppAtomRegistryProvider>,
  );
  await vi.waitFor(() => {
    expect(
      screen.container.querySelector('[data-node="implement"]')?.getAttribute("data-lit"),
    ).toBe("true");
    expect(screen.container.querySelector('[data-node="review"]')?.getAttribute("data-lit")).toBe(
      "false",
    );
    expect(
      screen.container.querySelector('[data-edge="foreman->implement"]')?.textContent,
    ).toContain("Fix the login redirect");
  });
  await expect.element(screen.getByText("t3/fix-login")).toBeInTheDocument();
});
