import { describe, expect, it, vi } from "vite-plus/test";

import {
  AUTOMATIONS_SETTINGS_PATH,
  makeOpenAutomationsCommand,
} from "./scheduledAutomationCommands";

describe("scheduled automation commands", () => {
  it("opens the shared web/Electron settings route from the command palette", async () => {
    const navigate = vi.fn(async () => undefined);
    const command = makeOpenAutomationsCommand(navigate);

    expect(command).toMatchObject({
      value: "action:automations",
      title: "Open automations",
      searchTerms: expect.arrayContaining(["automations", "scheduled", "cron"]),
    });
    await command.run();
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(AUTOMATIONS_SETTINGS_PATH);
  });
});
