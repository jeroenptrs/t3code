export const AUTOMATIONS_SETTINGS_PATH = "/settings/automations" as const;

export function makeOpenAutomationsCommand(
  navigate: (path: typeof AUTOMATIONS_SETTINGS_PATH) => Promise<void>,
) {
  return {
    value: "action:automations",
    title: "Open automations",
    searchTerms: ["automations", "scheduled", "schedule", "cron", "settings"],
    run: () => navigate(AUTOMATIONS_SETTINGS_PATH),
  } as const;
}
