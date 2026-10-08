import { createFileRoute } from "@tanstack/react-router";

import { UsersSettings } from "../components/settings/UsersSettings";

export const Route = createFileRoute("/_chat/settings/users")({
  component: UsersSettings,
});
