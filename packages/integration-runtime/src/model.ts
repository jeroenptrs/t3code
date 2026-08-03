import type { CommandId, MessageId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";

export const INGRESS_IDENTITY_VERSION = 1 as const;

export type IngressIntegration = "slack" | "jira";

/** Stable, platform-neutral identity supplied by an ingress adapter. */
export interface IngressInvocation {
  readonly identityVersion: typeof INGRESS_IDENTITY_VERSION;
  readonly integration: IngressIntegration;
  readonly tenantId: string;
  readonly surface: string;
  readonly invocationId: string;
  readonly prompt: string;
}

export interface StandardIngressTarget {
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection | null;
}

export interface IngressRequest {
  readonly invocation: IngressInvocation;
  readonly target: StandardIngressTarget;
  readonly requestedAt: string;
}

export interface IngressIds {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly createCommandId: CommandId;
  readonly startCommandId: CommandId;
}

export type IngressRecovery = "created" | "resumed" | "already-started" | "unverified";

export interface IngressResult {
  readonly recovery: IngressRecovery;
  readonly threadId: ThreadId;
  readonly deepLink: string;
}

export type IngressFailureCode =
  | "invalid_request"
  | "project_not_found"
  | "model_unavailable"
  | "authentication_failed"
  | "authorization_failed"
  | "t3_unavailable";

export class IngressFailure extends Error {
  readonly _tag = "IngressFailure";
  readonly code: IngressFailureCode;

  constructor(code: IngressFailureCode, message: string) {
    super(message);
    this.name = "IngressFailure";
    this.code = code;
  }
}
