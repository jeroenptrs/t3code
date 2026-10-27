import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { pairEnvironment } = vi.hoisted(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  return {
    pairEnvironment: vi.fn<(url: string) => Promise<{ ok: boolean; error: string | null }>>(),
  };
});

vi.mock("../connection/onboarding", () => ({ pairEnvironment }));

import { tvAtomRegistry } from "./atom-registry";
import { openPairingLink, pairingFormAtom, updatePairingForm } from "./pairing-form";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("openPairingLink", () => {
  beforeEach(() => {
    pairEnvironment.mockReset();
    updatePairingForm({ host: "", code: "", pending: false, error: null });
  });

  it("queues a link that arrives mid-pairing and submits it once the first settles", async () => {
    const first = deferred<{ ok: boolean; error: string | null }>();
    pairEnvironment.mockReturnValueOnce(first.promise);
    pairEnvironment.mockResolvedValueOnce({ ok: true, error: null });

    openPairingLink({ host: "https://one.example", code: "AAA" });
    expect(tvAtomRegistry.get(pairingFormAtom).pending).toBe(true);

    openPairingLink({ host: "https://two.example", code: "BBB" });
    // The second link does not overwrite the in-flight form.
    expect(tvAtomRegistry.get(pairingFormAtom)).toMatchObject({
      host: "https://one.example",
      code: "AAA",
    });
    expect(pairEnvironment).toHaveBeenCalledTimes(1);

    first.resolve({ ok: false, error: "expired" });
    await vi.waitFor(() => expect(pairEnvironment).toHaveBeenCalledTimes(2));
    expect(pairEnvironment.mock.calls[1]?.[0]).toContain("two.example");
    expect(pairEnvironment.mock.calls[1]?.[0]).toContain("token=BBB");
    await vi.waitFor(() => expect(tvAtomRegistry.get(pairingFormAtom).pending).toBe(false));
    expect(tvAtomRegistry.get(pairingFormAtom).error).toBeNull();
  });
});
