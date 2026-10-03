import {
  ModelSelection,
  ProjectId,
  type ModelSelection as ModelSelectionType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);

export interface SlackAppConfig {
  readonly slackAppToken: string;
  readonly slackBotToken: string;
  readonly t3HttpBaseUrl: string;
  readonly t3PublicBaseUrl: string;
  readonly t3BearerCredentialFile: string;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelectionType | null;
  readonly healthHost: string;
  readonly healthPort: number;
  readonly credentialExpiryWarningDays: number;
  readonly conversationAuditLogFile: string;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

const url = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = required(env, name);
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https.`);
  }
  return parsed.toString();
};

const modelSelection = (env: NodeJS.ProcessEnv): ModelSelectionType | null => {
  const raw = env.T3_MODEL_SELECTION?.trim();
  if (!raw) return null;
  return decodeModelSelection(JSON.parse(raw));
};

export function decodeSlackAppConfig(env: NodeJS.ProcessEnv): SlackAppConfig {
  const healthPortRaw = env.SLACK_HEALTH_PORT?.trim() ?? "3210";
  const healthPort = Number(healthPortRaw);
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
    throw new Error("SLACK_HEALTH_PORT must be an integer from 1 through 65535.");
  }
  const credentialExpiryWarningDaysRaw = env.T3_CREDENTIAL_EXPIRY_WARNING_DAYS?.trim() || "10";
  const credentialExpiryWarningDays = Number(credentialExpiryWarningDaysRaw);
  if (!Number.isInteger(credentialExpiryWarningDays) || credentialExpiryWarningDays < 1) {
    throw new Error("T3_CREDENTIAL_EXPIRY_WARNING_DAYS must be a positive integer.");
  }
  return {
    slackAppToken: required(env, "SLACK_APP_TOKEN"),
    slackBotToken: required(env, "SLACK_BOT_TOKEN"),
    t3HttpBaseUrl: url(env, "T3_HTTP_URL"),
    t3PublicBaseUrl: url(env, "T3_PUBLIC_URL"),
    t3BearerCredentialFile: required(env, "T3_BEARER_CREDENTIAL_FILE"),
    projectId: ProjectId.make(required(env, "T3_PROJECT_ID")),
    modelSelection: modelSelection(env),
    healthHost: env.SLACK_HEALTH_HOST?.trim() || "127.0.0.1",
    healthPort,
    credentialExpiryWarningDays,
    conversationAuditLogFile:
      env.SLACK_CONVERSATION_AUDIT_LOG_FILE?.trim() || ".t3/slack/conversation-starts.jsonl",
  };
}
