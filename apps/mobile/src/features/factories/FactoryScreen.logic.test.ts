import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { factoryModelLabel } from "./FactoryScreen.logic";

const claude = ProviderInstanceId.make("claude");
const providers = [
  {
    instanceId: claude,
    models: [{ slug: "claude-haiku-5-5", name: "Haiku 5.5" }],
  },
];

describe("factoryModelLabel", () => {
  it.each([
    [null, "Project default"],
    [{ instanceId: claude, model: "claude-haiku-5-5" }, "Haiku 5.5"],
    [{ instanceId: claude, model: "claude-unlisted" }, "claude-unlisted"],
    [
      { instanceId: ProviderInstanceId.make("gone"), model: "claude-haiku-5-5" },
      "claude-haiku-5-5",
    ],
  ] as const)("shows %j as %s", (model, label) => {
    expect(factoryModelLabel(model, providers)).toBe(label);
  });
});
