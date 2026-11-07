import { createJiraEnvironmentAtoms } from "@t3tools/client-runtime/state/jira";
import { connectionAtomRuntime } from "../connection/runtime";

export const jiraEnvironment = createJiraEnvironmentAtoms(connectionAtomRuntime);
