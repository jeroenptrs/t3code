import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useJiraCapabilities } from "~/state/jira";
import { JiraViewPicker } from "../jira/JiraIssueListControls";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Field } from "./scheduledTaskFields";
import type { DraftState } from "./scheduledTasksSettings.logic";

type JiraQueryDraft = Pick<
  DraftState,
  "jiraSite" | "jiraQueryKind" | "jql" | "jiraFilterId" | "jiraPollMinutes"
>;

/**
 * The site, query, and interval of a Jira query trigger. Saved filters are listed as the Jira
 * views read them, so the picker shows only for the reader's site; elsewhere JQL is the way.
 */
export function JiraQueryTriggerFields({
  environmentId,
  draft,
  onChange,
}: {
  environmentId: EnvironmentId;
  draft: JiraQueryDraft;
  onChange: (patch: Partial<JiraQueryDraft>) => void;
}) {
  const capabilities = useJiraCapabilities(environmentId);
  const [filterName, setFilterName] = useState<string | null>(null);
  const sites = [...new Set(capabilities?.identities.map((identity) => identity.site) ?? [])];
  if (draft.jiraSite && !sites.includes(draft.jiraSite)) sites.push(draft.jiraSite);
  const offersFilters = capabilities?.reader?.site === draft.jiraSite;
  const usesFilter = draft.jiraQueryKind === "filter";
  return (
    <div className="space-y-4">
      <Field label="Site" htmlFor="scheduled-task-jira-site">
        <Select
          value={draft.jiraSite}
          onValueChange={(site) => {
            if (typeof site !== "string") return;
            onChange({ jiraSite: site, jiraFilterId: "", jiraQueryKind: "jql" });
            setFilterName(null);
          }}
        >
          <SelectTrigger id="scheduled-task-jira-site" size="sm">
            <SelectValue>
              {draft.jiraSite || (sites.length === 0 ? "No Jira sites configured" : "Pick a site")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {sites.map((site) => (
              <SelectItem key={site} value={site}>
                {site}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      {usesFilter || offersFilters ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label>Query</Label>
          <JiraViewPicker
            environmentId={environmentId}
            label={
              usesFilter
                ? (filterName ?? `Saved filter ${draft.jiraFilterId}`)
                : "JQL, or pick a saved filter"
            }
            selectedFilterId={usesFilter ? draft.jiraFilterId : null}
            onSelectFilter={(filterId, filter) => {
              onChange({ jiraQueryKind: "filter", jiraFilterId: filterId });
              setFilterName(filter?.name ?? null);
            }}
            onUseJql={() => onChange({ jiraQueryKind: "jql" })}
          />
        </div>
      ) : null}
      {usesFilter ? null : (
        <Field label="JQL" htmlFor="scheduled-task-jql">
          <Textarea
            id="scheduled-task-jql"
            placeholder="project = PROJ AND labels = agent"
            value={draft.jql}
            onChange={(event) => onChange({ jql: event.target.value })}
          />
        </Field>
      )}
      <div className="flex items-center gap-2">
        <Label htmlFor="scheduled-task-jira-poll">Check every</Label>
        <Input
          type="number"
          id="scheduled-task-jira-poll"
          nativeInput
          min={5}
          step={1}
          className="w-24"
          value={draft.jiraPollMinutes}
          onChange={(event) => onChange({ jiraPollMinutes: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">minutes</span>
      </div>
    </div>
  );
}
