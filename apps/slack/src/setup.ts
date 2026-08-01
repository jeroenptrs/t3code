import {
  branchOptions,
  encodeBranchSelectionOption,
  defaultBranch,
  modelSelectionsEqual,
  modelEffortOptions,
  projectOptions,
  type IngressInvocation,
  IngressFailure,
  type ModelEffortOption,
  type T3Transport,
} from "@t3tools/integration-runtime";
import type {
  ModelSelection,
  OrchestrationProjectShell,
  VcsListRefsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const SETUP_CALLBACK_ID = "t3_custom_setup_v1";
export const SETUP_PROJECT_ACTION = "t3_setup_project";
export const SETUP_WORKSPACE_ACTION = "t3_setup_workspace";
export const SETUP_BRANCH_ACTION = "t3_setup_branch";
export const SETUP_MODEL_ACTION = "t3_setup_model";
export const SETUP_PROMPT_ACTION = "t3_setup_prompt";
export const SETUP_CONFIGURE_ACTION = "t3_setup_configure";
export const SETUP_PROJECT_OPTIONS_ACTION = SETUP_PROJECT_ACTION;
export const SLACK_PROMPT_MAX_LENGTH = 3_000;

export interface SetupOrigin {
  readonly invocation: Omit<IngressInvocation, "prompt">;
  readonly response: {
    readonly kind: "message" | "response-url";
    readonly channelId: string;
    readonly responseKey?: string;
    readonly userId?: string;
    readonly threadTimestamp?: string;
  };
}

export interface SetupCatalog {
  readonly project: OrchestrationProjectShell;
  readonly projects: ReturnType<typeof projectOptions>;
  readonly refs: VcsListRefsResult;
  readonly models: ReadonlyArray<ModelEffortOption>;
  readonly defaultModelSelection: ModelSelection | null;
}

const resolveSetupProject = (
  shell: Parameters<typeof projectOptions>[0],
  projectId: string,
  fallbackToFirstProject: boolean,
) => {
  const preferred = shell.projects.find((project) => project.id === projectId);
  const project = preferred ?? (fallbackToFirstProject ? shell.projects[0] : undefined);
  if (!project) {
    throw new IngressFailure(
      "project_not_found",
      fallbackToFirstProject
        ? "No T3 Code projects are available to configure."
        : "The selected T3 project no longer exists.",
    );
  }
  return project;
};

export const loadSetupCatalog = Effect.fn("slack.loadSetupCatalog")(function* (input: {
  readonly transport: T3Transport;
  readonly projectId: string;
  readonly integrationDefault: ModelSelection | null;
  readonly query?: string;
  readonly fallbackToFirstProject?: boolean;
}) {
  const [shell, config] = yield* Effect.all([
    input.transport.getShellSnapshot(),
    input.transport.getServerConfig(),
  ]);
  const project = yield* Effect.try({
    try: () => resolveSetupProject(shell, input.projectId, input.fallbackToFirstProject === true),
    catch: (cause) =>
      cause instanceof IngressFailure
        ? cause
        : new IngressFailure("invalid_request", "The selected project is invalid."),
  });
  const refs = yield* input.transport.listRefs({
    cwd: project.workspaceRoot,
    ...(input.query?.trim() ? { query: input.query.trim() } : {}),
    includeMatchingRemoteRefs: true,
    limit: 200,
  });
  return {
    project,
    projects: projectOptions(shell),
    refs,
    models: modelEffortOptions({ config, project, integrationDefault: input.integrationDefault }),
    defaultModelSelection: input.integrationDefault ?? project.defaultModelSelection,
  } satisfies SetupCatalog;
});

export const loadBranchCatalog = Effect.fn("slack.loadBranchCatalog")(function* (input: {
  readonly transport: T3Transport;
  readonly projectId: string;
  readonly query: string;
}) {
  const shell = yield* input.transport.getShellSnapshot();
  const project = yield* Effect.try({
    try: () => resolveSetupProject(shell, input.projectId, false),
    catch: (cause) =>
      cause instanceof IngressFailure
        ? cause
        : new IngressFailure("invalid_request", "The selected project is invalid."),
  });
  const refs = yield* input.transport.listRefs({
    cwd: project.workspaceRoot,
    ...(input.query.trim() ? { query: input.query.trim() } : {}),
    includeMatchingRemoteRefs: true,
    limit: 200,
  });
  return { project, refs };
});

export const loadModelOptions = Effect.fn("slack.loadModelOptions")(function* (input: {
  readonly transport: T3Transport;
  readonly projectId: string;
  readonly integrationDefault: ModelSelection | null;
}) {
  const [shell, config] = yield* Effect.all([
    input.transport.getShellSnapshot(),
    input.transport.getServerConfig(),
  ]);
  const project = yield* Effect.try({
    try: () => resolveSetupProject(shell, input.projectId, false),
    catch: (cause) =>
      cause instanceof IngressFailure
        ? cause
        : new IngressFailure("invalid_request", "The selected project is invalid."),
  });
  return modelEffortOptions({ config, project, integrationDefault: input.integrationDefault });
});

export const loadProjectOptions = Effect.fn("slack.loadProjectOptions")(function* (input: {
  readonly transport: T3Transport;
  readonly query: string;
}) {
  const shell = yield* input.transport.getShellSnapshot();
  const query = input.query.trim().toLowerCase();
  return projectOptions(shell)
    .filter((option) =>
      query ? `${option.label} ${option.description}`.toLowerCase().includes(query) : true,
    )
    .slice(0, 100);
});

const slackOption = (value: string, text: string, description?: string) => ({
  text: { type: "plain_text" as const, text: text.slice(0, 75) },
  value,
  ...(description
    ? { description: { type: "plain_text" as const, text: description.slice(0, 75) } }
    : {}),
});

const visibleBranchBadges = (
  option: ReturnType<typeof branchOptions>[number],
  catalog: Pick<SetupCatalog, "project" | "refs">,
) =>
  option.badges.filter(
    (badge) => badge !== "worktree" || option.ref.worktreePath !== catalog.project.workspaceRoot,
  );

export function buildSetupView(input: {
  readonly origin: SetupOrigin;
  readonly prompt: string;
  readonly catalog: SetupCatalog;
  readonly workspace?: "current" | "new-worktree";
  readonly branch?: string | null;
  readonly modelOption?: string;
}) {
  const workspace = input.catalog.refs.isRepo ? (input.workspace ?? "current") : "current";
  const initialRef = defaultBranch(input.catalog.refs, workspace);
  const branch = input.branch ?? (initialRef ? encodeBranchSelectionOption(initialRef) : null);
  const model =
    input.catalog.models.find((option) => option.value === input.modelOption) ??
    input.catalog.models.find(
      (option) =>
        input.catalog.defaultModelSelection !== null &&
        modelSelectionsEqual(option.modelSelection, input.catalog.defaultModelSelection),
    ) ??
    input.catalog.models.find(
      (option) =>
        option.isDefault &&
        option.modelSelection.instanceId === input.catalog.defaultModelSelection?.instanceId &&
        option.modelSelection.model === input.catalog.defaultModelSelection?.model,
    ) ??
    input.catalog.models[0];
  const selectedRef = branchOptions(input.catalog.refs).find((option) => option.value === branch);
  const branchLabel = selectedRef
    ? `${selectedRef.label}${visibleBranchBadges(selectedRef, input.catalog)
        .map((badge) => ` · ${badge}`)
        .join("")}`
    : input.catalog.refs.isRepo
      ? "Select a branch"
      : "No repository";
  const blocks = [
    {
      type: "input",
      block_id: "t3_setup_prompt_block",
      label: { type: "plain_text", text: "Prompt" },
      element: {
        type: "plain_text_input",
        action_id: SETUP_PROMPT_ACTION,
        multiline: true,
        min_length: 1,
        max_length: SLACK_PROMPT_MAX_LENGTH,
        initial_value: input.prompt,
      },
    },
    {
      type: "input",
      block_id: "t3_setup_project_block",
      dispatch_action: true,
      label: { type: "plain_text", text: "Project" },
      element: {
        type: "external_select",
        action_id: SETUP_PROJECT_ACTION,
        min_query_length: 0,
        placeholder: { type: "plain_text", text: "Search projects" },
        initial_option: slackOption(
          input.catalog.project.id,
          input.catalog.project.title,
          input.catalog.project.workspaceRoot,
        ),
      },
    },
    {
      type: "input",
      block_id: `t3_setup_workspace_block:${input.catalog.project.id}`,
      dispatch_action: true,
      label: { type: "plain_text", text: "Workspace" },
      element: {
        type: "static_select",
        action_id: SETUP_WORKSPACE_ACTION,
        options: [
          slackOption("current", "Current"),
          ...(input.catalog.refs.isRepo ? [slackOption("new-worktree", "New worktree")] : []),
        ],
        initial_option: slackOption(
          workspace,
          workspace === "current" ? "Current" : "New worktree",
        ),
      },
    },
    {
      type: "input",
      block_id: `t3_setup_branch_block:${input.catalog.project.id}:${workspace}`,
      label: { type: "plain_text", text: "Branch" },
      element: input.catalog.refs.isRepo
        ? {
            type: "external_select",
            action_id: SETUP_BRANCH_ACTION,
            min_query_length: 0,
            placeholder: { type: "plain_text", text: "Search branches" },
            ...(branch ? { initial_option: slackOption(branch, branchLabel) } : {}),
          }
        : {
            type: "static_select",
            action_id: SETUP_BRANCH_ACTION,
            options: [slackOption("no-repository", "No repository")],
            initial_option: slackOption("no-repository", "No repository"),
            confirm: {
              title: { type: "plain_text", text: "No repository" },
              text: { type: "mrkdwn", text: "This project uses its current folder." },
              confirm: { type: "plain_text", text: "Continue" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
    },
    {
      type: "input",
      block_id: `t3_setup_model_block:${input.catalog.project.id}`,
      label: { type: "plain_text", text: "Model / effort" },
      element: {
        type: "external_select",
        action_id: SETUP_MODEL_ACTION,
        min_query_length: 0,
        placeholder: { type: "plain_text", text: "Search models" },
        ...(model ? { initial_option: slackOption(model.value, model.label, model.group) } : {}),
      },
    },
  ];
  return {
    type: "modal" as const,
    callback_id: SETUP_CALLBACK_ID,
    private_metadata: JSON.stringify(input.origin),
    title: { type: "plain_text" as const, text: "Start in T3 Code" },
    submit: { type: "plain_text" as const, text: "Start" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks,
  };
}

export function buildLoadingSetupView(input: {
  readonly origin: SetupOrigin;
  readonly prompt: string;
}) {
  return {
    type: "modal" as const,
    callback_id: `${SETUP_CALLBACK_ID}:loading`,
    private_metadata: JSON.stringify(input.origin),
    title: { type: "plain_text" as const, text: "Start in T3 Code" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "section",
        block_id: "t3_setup_loading_prompt",
        text: { type: "plain_text", text: input.prompt },
      },
      {
        type: "section",
        block_id: "t3_setup_loading_status",
        text: { type: "plain_text", text: "Loading T3 Code projects and models…" },
      },
    ],
  };
}

export function buildSetupErrorView(input: {
  readonly origin: SetupOrigin;
  readonly message: string;
}) {
  return {
    type: "modal" as const,
    callback_id: `${SETUP_CALLBACK_ID}:error`,
    private_metadata: JSON.stringify(input.origin),
    title: { type: "plain_text" as const, text: "Start in T3 Code" },
    close: { type: "plain_text" as const, text: "Close" },
    blocks: [
      {
        type: "section",
        block_id: "t3_setup_error",
        text: { type: "plain_text", text: input.message.slice(0, SLACK_PROMPT_MAX_LENGTH) },
      },
    ],
  };
}

export const branchSlackOptions = (catalog: Pick<SetupCatalog, "project" | "refs">) =>
  branchOptions(catalog.refs)
    .slice(0, 100)
    .map((option) =>
      slackOption(
        option.value,
        `${option.label}${visibleBranchBadges(option, catalog)
          .map((badge) => ` · ${badge}`)
          .join("")}`,
      ),
    );

export const projectSlackOptions = (projects: SetupCatalog["projects"]) =>
  projects.map((option) => slackOption(option.value, option.label, option.description));

export const modelSlackOptionGroups = (models: ReadonlyArray<ModelEffortOption>, query: string) => {
  const groups = new Map<string, Array<ReturnType<typeof slackOption>>>();
  for (const option of models) {
    if (!`${option.group} ${option.label}`.toLowerCase().includes(query.toLowerCase())) continue;
    const group = groups.get(option.group) ?? [];
    if (group.length < 100) group.push(slackOption(option.value, option.label));
    groups.set(option.group, group);
  }
  return [...groups].slice(0, 100).map(([label, options]) => ({
    label: { type: "plain_text" as const, text: label.slice(0, 75) },
    options,
  }));
};
