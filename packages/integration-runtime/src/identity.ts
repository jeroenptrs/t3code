import { sha256 } from "@noble/hashes/sha2";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";

import type { IngressIds, IngressInvocation } from "./model.ts";

const ID_PREFIX = "t3i";

function digest(value: string): string {
  return Encoding.encodeBase64Url(sha256(new TextEncoder().encode(value)));
}

/**
 * Converts a secret-bearing platform value, such as a Slack response URL, into
 * an identity safe to persist in T3 entity IDs and platform metadata.
 */
export function opaqueInvocationId(value: string): string {
  return digest(value);
}

export function deriveIngressIds(invocation: IngressInvocation): IngressIds {
  const invocationDigest = digest(
    JSON.stringify([
      invocation.identityVersion,
      invocation.integration,
      invocation.tenantId,
      invocation.surface,
      invocation.invocationId,
    ]),
  );
  const base = [
    ID_PREFIX,
    `v${invocation.identityVersion}`,
    invocation.integration,
    invocation.surface,
    invocationDigest,
  ].join(":");

  return {
    threadId: ThreadId.make(`${base}:thread`),
    messageId: MessageId.make(`${base}:message:initial`),
    createCommandId: CommandId.make(`${base}:command:create`),
    startCommandId: CommandId.make(`${base}:command:start`),
  };
}
