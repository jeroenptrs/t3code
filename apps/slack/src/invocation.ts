import {
  INGRESS_IDENTITY_VERSION,
  opaqueInvocationId,
  type IngressInvocation,
} from "@t3tools/integration-runtime";

export interface SlashInvocationInput {
  readonly teamId: string;
  readonly responseUrl: string;
  readonly text: string;
}

export interface MentionInvocationInput {
  readonly teamId: string;
  readonly channelId: string;
  readonly botUserId: string;
  readonly eventId?: string;
  readonly messageTimestamp: string;
  readonly text: string;
}

export interface DirectMessageInvocationInput {
  readonly teamId: string;
  readonly channelId: string;
  readonly rootTimestamp: string;
  readonly text: string;
}

export const normalizeSlashInvocation = (input: SlashInvocationInput): IngressInvocation => ({
  identityVersion: INGRESS_IDENTITY_VERSION,
  integration: "slack",
  tenantId: input.teamId,
  surface: "slash",
  invocationId: opaqueInvocationId(input.responseUrl),
  prompt: input.text.trim(),
});

export const normalizeMentionInvocation = (input: MentionInvocationInput): IngressInvocation => ({
  identityVersion: INGRESS_IDENTITY_VERSION,
  integration: "slack",
  tenantId: input.teamId,
  surface: "mention",
  invocationId: input.eventId?.trim() || `${input.channelId}:${input.messageTimestamp}`,
  prompt: input.text
    .replace(new RegExp(`<@${input.botUserId}(?:\\|[^>]+)?>`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim(),
});

export const normalizeCustomSlashInvocation = (input: SlashInvocationInput): IngressInvocation => ({
  ...normalizeSlashInvocation(input),
  surface: "custom-slash",
});

const CUSTOM_MENTION_PREFIX = /^custom(?:\s*:|\s+|$)/i;

export const isCustomMentionPrompt = (prompt: string): boolean =>
  CUSTOM_MENTION_PREFIX.test(prompt);

export const stripCustomMentionPrefix = (prompt: string): string =>
  prompt.replace(CUSTOM_MENTION_PREFIX, "").trim();

export const normalizeCustomMentionInvocation = (
  input: MentionInvocationInput,
): IngressInvocation => {
  const invocation = normalizeMentionInvocation(input);
  return {
    ...invocation,
    surface: "custom-mention",
    prompt: stripCustomMentionPrefix(invocation.prompt),
  };
};

export const normalizeDirectMessageInvocation = (
  input: DirectMessageInvocationInput,
): IngressInvocation => ({
  identityVersion: INGRESS_IDENTITY_VERSION,
  integration: "slack",
  tenantId: input.teamId,
  surface: "dm",
  invocationId: `${input.channelId}:${input.rootTimestamp}`,
  prompt: input.text.trim(),
});
