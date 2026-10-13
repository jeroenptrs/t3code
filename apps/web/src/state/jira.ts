import { useAtomValue } from "@effect/atom-react";
import {
  createJiraEnvironmentAtoms,
  resolveJiraCapabilities,
} from "@t3tools/client-runtime/state/jira";
import { JiraError, type EnvironmentId, type JiraCapabilities } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentIds, usePrimaryEnvironmentId } from "./environments";

export const jiraEnvironment = createJiraEnvironmentAtoms(connectionAtomRuntime);

const NO_ENVIRONMENT_ATOM = Atom.make(AsyncResult.initial<JiraCapabilities>()).pipe(
  Atom.withLabel("web-jira:capabilities:none"),
);

/**
 * What every Jira surface gates on. Null until the environment answers, so nothing flashes in and
 * out; not configured when it cannot answer, which covers servers that predate Jira.
 */
export function useJiraCapabilities(environmentId: EnvironmentId | null): JiraCapabilities | null {
  const result = useAtomValue(
    environmentId === null
      ? NO_ENVIRONMENT_ATOM
      : jiraEnvironment.capabilities({ environmentId, input: {} }),
  );
  return resolveJiraCapabilities(result);
}

export type JiraFailureReason = JiraError["reason"];

const isJiraError = Schema.is(JiraError);

/** The Jira reason behind a query failure, or null when the failure was not Jira's. */
export function jiraFailureReason(failure: unknown): JiraFailureReason | null {
  return isJiraError(failure) ? failure.reason : null;
}

/**
 * The one environment the workspace-level Jira surfaces (the `/issues` page, its sidebar and
 * palette entries) read through: the primary server, or the first known one where the client has
 * no primary, such as the hosted web app. Threads read through their own environment instead.
 */
export function useJiraEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentIds = useEnvironmentIds();
  return primaryEnvironmentId ?? environmentIds[0] ?? null;
}
