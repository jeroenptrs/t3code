import {
  type ModelSelection as ModelSelectionType,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type ProviderOptionSelection,
  type ServerConfig,
  type VcsListRefsResult,
  type VcsRef,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
  isPrimaryModelEffortOptionId,
} from "@t3tools/shared/model";
import { sha256 } from "@noble/hashes/sha2";

import { IngressFailure } from "./model.ts";
import { isUsableProviderInstance } from "./resolution.ts";
import * as Encoding from "effect/Encoding";

export interface ProjectOption {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export interface BranchOption {
  readonly value: string;
  readonly label: string;
  readonly badges: ReadonlyArray<"current" | "worktree">;
  readonly ref: VcsRef;
}

export interface ModelEffortOption {
  readonly value: string;
  readonly label: string;
  readonly group: string;
  readonly modelSelection: ModelSelectionType;
  readonly isDefault: boolean;
}

const compactFingerprint = (value: string): string => {
  const digest = sha256(new TextEncoder().encode(value));
  return Encoding.encodeBase64Url(digest).slice(0, 22);
};

const canonicalModelSelection = (selection: ModelSelectionType): string =>
  [
    selection.instanceId,
    selection.model,
    ...(selection.options ?? [])
      .map((option) => `${option.id}=${String(option.value)}`)
      .sort((left, right) => left.localeCompare(right)),
  ].join("\u0000");

export const encodeModelSelectionOption = (selection: ModelSelectionType): string =>
  `m:${compactFingerprint(canonicalModelSelection(selection))}`;

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const leftOptions = new Map((left.options ?? []).map((option) => [option.id, option.value]));
  const rightOptions = new Map((right.options ?? []).map((option) => [option.id, option.value]));
  if (leftOptions.size !== rightOptions.size) return false;
  return [...leftOptions].every(([id, value]) => Object.is(rightOptions.get(id), value));
}

const validateCompactOption = (value: string, prefix: "b:" | "m:", message: string): string => {
  if (!new RegExp(`^${prefix}[A-Za-z0-9_-]{22}$`).test(value)) {
    throw new IngressFailure("invalid_request", message);
  }
  return value;
};

export const projectOptions = (shell: OrchestrationShellSnapshot): ReadonlyArray<ProjectOption> =>
  shell.projects.map((project) => ({
    value: project.id,
    label: project.title,
    description: project.workspaceRoot,
  }));

export function findProject(
  shell: OrchestrationShellSnapshot,
  projectId: string,
): OrchestrationProjectShell {
  const project = shell.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new IngressFailure("project_not_found", "The selected T3 project no longer exists.");
  }
  return project;
}

export const encodeBranchSelectionOption = (ref: VcsRef): string =>
  `b:${compactFingerprint(
    [
      ref.name,
      ref.worktreePath ?? "",
      ref.isRemote ? "remote" : "local",
      ref.remoteName ?? "",
    ].join("\u0000"),
  )}`;

export const decodeBranchSelectionOption = (value: string): string =>
  validateCompactOption(value, "b:", "The selected branch is no longer valid.");

export const branchOptions = (result: VcsListRefsResult): ReadonlyArray<BranchOption> =>
  result.refs.map((ref) => ({
    value: encodeBranchSelectionOption(ref),
    label: ref.name,
    badges: [
      ...(ref.current ? (["current"] as const) : []),
      ...(ref.worktreePath ? (["worktree"] as const) : []),
    ],
    ref,
  }));

export function defaultBranch(
  result: VcsListRefsResult,
  workspace: "current" | "new-worktree",
): VcsRef | null {
  if (!result.isRepo) return null;
  return workspace === "new-worktree"
    ? (result.refs.find((ref) => ref.isDefault) ??
        result.refs.find((ref) => ref.current) ??
        result.refs[0] ??
        null)
    : (result.refs.find((ref) => ref.current && !ref.isRemote) ??
        result.refs.find((ref) => ref.current) ??
        result.refs[0] ??
        null);
}

const baseSelectionsForModel = (input: {
  readonly integrationDefault: ModelSelectionType | null;
  readonly projectDefault: ModelSelectionType | null;
  readonly instanceId: string;
  readonly model: string;
}): ReadonlyArray<ProviderOptionSelection> | undefined => {
  for (const selection of [input.integrationDefault, input.projectDefault]) {
    if (selection?.instanceId === input.instanceId && selection.model === input.model) {
      return selection.options;
    }
  }
  return undefined;
};

export function modelEffortOptions(input: {
  readonly config: ServerConfig;
  readonly project: OrchestrationProjectShell;
  readonly integrationDefault: ModelSelectionType | null;
}): ReadonlyArray<ModelEffortOption> {
  const output: Array<ModelEffortOption> = [];
  for (const provider of input.config.providers) {
    if (!isUsableProviderInstance(provider)) {
      continue;
    }
    const displayName = provider.displayName ?? provider.badgeLabel ?? provider.instanceId;
    const group =
      displayName === provider.instanceId ? displayName : `${displayName} (${provider.instanceId})`;
    for (const model of provider.models) {
      const baseSelections = baseSelectionsForModel({
        integrationDefault: input.integrationDefault,
        projectDefault: input.project.defaultModelSelection,
        instanceId: provider.instanceId,
        model: model.slug,
      });
      const descriptors = getProviderOptionDescriptors({
        caps: model.capabilities ?? {},
        selections: baseSelections,
      });
      const effort = descriptors.find(
        (descriptor) => descriptor.type === "select" && isPrimaryModelEffortOptionId(descriptor.id),
      );
      const defaults = buildProviderOptionSelectionsFromDescriptors(descriptors) ?? [];
      const choices = effort?.type === "select" ? effort.options : [];
      const variants = choices.length > 0 ? choices : [null];
      for (const choice of variants) {
        const options = choice
          ? [
              ...defaults.filter((selection) => selection.id !== effort?.id),
              { id: effort!.id, value: choice.id },
            ]
          : defaults;
        const modelSelection: ModelSelectionType = {
          instanceId: provider.instanceId,
          model: model.slug,
          ...(options.length > 0 ? { options } : {}),
        };
        output.push({
          value: encodeModelSelectionOption(modelSelection),
          label: choice ? `${model.name} · ${choice.label}` : model.name,
          group,
          modelSelection,
          isDefault: choice === null || choice.id === effort?.currentValue,
        });
      }
    }
  }
  return output;
}

export function resolveModelEffortSelection(
  options: ReadonlyArray<ModelEffortOption>,
  encoded: string,
): ModelSelectionType {
  validateCompactOption(encoded, "m:", "The selected model is no longer valid.");
  const match = options.find((option) => option.value === encoded);
  if (!match) {
    throw new IngressFailure("model_unavailable", "The selected model is no longer available.");
  }
  return match.modelSelection;
}
