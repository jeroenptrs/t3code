import { signedInGitLabHosts } from "@t3tools/client-runtime/scheduled-task-trigger";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Field } from "./scheduledTaskFields";
import type { DraftState } from "./scheduledTasksSettings.logic";

type GitLabProjectsDraft = Pick<
  DraftState,
  "gitlabHost" | "gitlabProjects" | "gitlabGroup" | "gitlabPollMinutes"
>;

/**
 * The host, projects or group, and interval of a GitLab projects trigger. The server polls as
 * the host's glab login, so the picker lists the hosts it is signed in to; with none listed,
 * the host is typed.
 */
export function GitLabProjectsTriggerFields({
  environmentId,
  draft,
  onChange,
}: {
  environmentId: EnvironmentId;
  draft: GitLabProjectsDraft;
  onChange: (patch: Partial<GitLabProjectsDraft>) => void;
}) {
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const hosts = signedInGitLabHosts(discovery.data?.sourceControlProviders ?? []);
  if (draft.gitlabHost && hosts.length > 0 && !hosts.includes(draft.gitlabHost)) {
    hosts.push(draft.gitlabHost);
  }
  return (
    <div className="space-y-4">
      <Field label="Host" htmlFor="scheduled-task-gitlab-host">
        {hosts.length === 0 ? (
          <Input
            id="scheduled-task-gitlab-host"
            placeholder="gitlab.com"
            value={draft.gitlabHost}
            onChange={(event) => onChange({ gitlabHost: event.target.value })}
          />
        ) : (
          <Select
            value={draft.gitlabHost}
            onValueChange={(host) => {
              if (typeof host === "string") onChange({ gitlabHost: host });
            }}
          >
            <SelectTrigger id="scheduled-task-gitlab-host" size="sm">
              <SelectValue>{draft.gitlabHost || "Pick a host"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {hosts.map((host) => (
                <SelectItem key={host} value={host}>
                  {host}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </Field>
      <Field label="Project paths, one per line" htmlFor="scheduled-task-gitlab-projects">
        <Textarea
          id="scheduled-task-gitlab-projects"
          placeholder={"acme/app\nacme/api"}
          value={draft.gitlabProjects}
          onChange={(event) => onChange({ gitlabProjects: event.target.value })}
        />
      </Field>
      <Field label="Group path (optional)" htmlFor="scheduled-task-gitlab-group">
        <Input
          id="scheduled-task-gitlab-group"
          placeholder="acme"
          value={draft.gitlabGroup}
          onChange={(event) => onChange({ gitlabGroup: event.target.value })}
        />
      </Field>
      <div className="flex items-center gap-2">
        <Label htmlFor="scheduled-task-gitlab-poll">Check every</Label>
        <Input
          type="number"
          id="scheduled-task-gitlab-poll"
          nativeInput
          min={5}
          step={1}
          className="w-24"
          value={draft.gitlabPollMinutes}
          onChange={(event) => onChange({ gitlabPollMinutes: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">minutes</span>
      </div>
    </div>
  );
}
