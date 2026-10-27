import { Atom } from "effect/reactivity";

import { pairEnvironment, type PairingOutcome } from "../connection/onboarding";
import { buildPairingUrl, parsePairingUrl } from "../lib/pairing";
import { tvAtomRegistry } from "./atom-registry";

export interface PairingFormState {
  readonly host: string;
  readonly code: string;
  readonly pending: boolean;
  readonly error: string | null;
}

// Development builds can prefill the form, because typing with the simulator's remote is slow.
const devPairing = __DEV__
  ? parsePairingUrl(process.env.EXPO_PUBLIC_TV_DEV_PAIRING_URL ?? "")
  : { host: "", code: "" };

/** The pairing form lives in the registry so a pairing link can fill and submit it. */
export const pairingFormAtom = Atom.make<PairingFormState>({
  host: devPairing.host,
  code: devPairing.code,
  pending: false,
  error: null,
}).pipe(Atom.keepAlive, Atom.withLabel("tv:pairing-form"));

export function updatePairingForm(patch: Partial<PairingFormState>): void {
  tvAtomRegistry.set(pairingFormAtom, { ...tvAtomRegistry.get(pairingFormAtom), ...patch });
}

// A pairing link that arrived while another pairing was in flight. It waits here instead of
// overwriting the form, and is submitted once the in-flight pairing settles. The latest link wins.
let queuedLink: { readonly host: string; readonly code: string } | null = null;

/** Fills the form from a pairing link and submits it, or queues it behind an in-flight pairing. */
export function openPairingLink(link: { readonly host: string; readonly code: string }): void {
  if (tvAtomRegistry.get(pairingFormAtom).pending) {
    queuedLink = link;
    return;
  }
  updatePairingForm({ host: link.host, code: link.code });
  void submitPairingForm();
}

/** Pairs with the host and code in the form. Either field accepts a whole pairing link. */
export async function submitPairingForm(): Promise<void> {
  const { host, code, pending } = tvAtomRegistry.get(pairingFormAtom);
  if (pending) return;
  const parsed = parsePairingUrl(host);
  const pairingUrl = buildPairingUrl(parsed.host || host, code || parsed.code);
  if (!pairingUrl) {
    updatePairingForm({ error: "Enter the host of a T3 Code environment." });
    return;
  }
  updatePairingForm({ pending: true, error: null });
  let outcome: PairingOutcome;
  try {
    outcome = await pairEnvironment(pairingUrl);
  } catch (error) {
    outcome = {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to pair with the environment.",
    };
  }
  updatePairingForm(
    outcome.ok ? { pending: false, code: "" } : { pending: false, error: outcome.error },
  );
  const next = queuedLink;
  queuedLink = null;
  if (next) openPairingLink(next);
}
