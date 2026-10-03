import * as NodeFSP from "node:fs/promises";

import { expect, it } from "vite-plus/test";

it("enables App Home and subscribes to app_home_opened", async () => {
  const manifest = await NodeFSP.readFile(new URL("../manifest.yaml", import.meta.url), "utf8");

  expect(manifest).toMatch(/app_home:\s+home_tab_enabled: true/);
  expect(manifest).toMatch(/bot_events:\s+- app_home_opened/);
});
