import type { EnvironmentId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleDotIcon,
  CircleUserRoundIcon,
  CodeIcon,
  FilterIcon,
  FlagIcon,
  ListFilterIcon,
  RepeatIcon,
  SearchIcon,
  ShapesIcon,
  StarIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { jiraEnvironment } from "~/state/jira";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";

import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  EMPTY_JIRA_FACET_SELECTION,
  countJiraFacetSelection,
  sortJiraFilterViews,
  type JiraIssueFacetKey,
  type JiraIssueFacetOption,
  type JiraIssueFacets,
  type JiraIssueFacetSelection,
} from "./jiraIssueList.logic";

/** Long enough that typing a name is one request, short enough to feel answered. */
const FILTER_SEARCH_DEBOUNCE_MS = 250;

/**
 * Picks the page's view: one of the reader's Jira filters, starred first, or any filter found by
 * name. Filters are only listed while the picker is open. Ad-hoc JQL sits at the bottom as the
 * escape hatch rather than the default.
 */
export function JiraViewPicker({
  environmentId,
  label,
  selectedFilterId,
  onSelectFilter,
  onUseJql,
}: {
  environmentId: EnvironmentId;
  label: string;
  selectedFilterId: string | null;
  onSelectFilter: (filterId: string) => void;
  onUseJql: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sentQuery = useDebouncedValue(query.trim().slice(0, 200), FILTER_SEARCH_DEBOUNCE_MS);
  const filtersQuery = useEnvironmentQuery(
    open
      ? jiraEnvironment.filters({
          environmentId,
          input: sentQuery.length > 0 ? { query: sentQuery } : {},
        })
      : null,
  );
  const filters = sortJiraFilterViews(filtersQuery.data?.filters ?? []);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={<Button variant="outline" />} aria-label={`View: ${label}`}>
        <FilterIcon aria-hidden />
        <span className="max-w-64 truncate">{label}</span>
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        <div className="p-1 pb-2">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              size="compact"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation();
              }}
              placeholder="Search Jira filters"
              aria-label="Search Jira filters"
            />
          </InputGroup>
        </div>
        {filters.length > 0 ? (
          <MenuRadioGroup
            value={selectedFilterId ?? ""}
            onValueChange={(next) => {
              if (typeof next === "string" && next.length > 0) onSelectFilter(next);
            }}
          >
            {filters.map((filter) => (
              <MenuRadioItem key={filter.id} value={filter.id}>
                <span className="flex min-w-0 items-center gap-2">
                  {filter.favourite ? (
                    <StarIcon aria-label="Starred" className="size-3.5" />
                  ) : (
                    <FilterIcon aria-hidden className="size-3.5" />
                  )}
                  <span className="min-w-0 max-w-72 truncate">{filter.name}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        ) : (
          <MenuItem disabled>
            {filtersQuery.data === null && filtersQuery.error === null
              ? "Loading filters…"
              : filtersQuery.data === null
                ? (filtersQuery.error ?? "Could not list filters.")
                : sentQuery.length > 0
                  ? "No filters match"
                  : "Search for a filter by name"}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem onClick={onUseJql}>
          <CodeIcon aria-hidden />
          Use JQL…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

const FACETS: ReadonlyArray<{ key: JiraIssueFacetKey; label: string; Icon: LucideIcon }> = [
  { key: "assignee", label: "Assignee", Icon: CircleUserRoundIcon },
  { key: "priority", label: "Priority", Icon: FlagIcon },
  { key: "issueType", label: "Issue type", Icon: ShapesIcon },
  { key: "sprint", label: "Sprint", Icon: RepeatIcon },
  { key: "status", label: "Status", Icon: CircleDotIcon },
];

function JiraFacetSubmenu({
  label,
  Icon,
  showAvatars,
  options,
  value,
  onChange,
}: {
  label: string;
  Icon: LucideIcon;
  showAvatars: boolean;
  options: ReadonlyArray<JiraIssueFacetOption>;
  value: ReadonlyArray<string>;
  onChange: (value: ReadonlyArray<string>) => void;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <Icon aria-hidden className="size-3.5" />
        <span className="flex-1">{label}</span>
        <span className="text-xs text-muted-foreground">
          {value.length === 0 ? "Any" : `${value.length} selected`}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuCheckboxItem checked={value.length === 0} onCheckedChange={() => onChange([])}>
          Any
        </MenuCheckboxItem>
        <MenuSeparator />
        {options.length === 0 ? (
          <MenuItem disabled>Nothing loaded</MenuItem>
        ) : (
          options.map((option) => (
            <MenuCheckboxItem
              key={option.value}
              checked={value.includes(option.value)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...value, option.value]
                    : value.filter((selected) => selected !== option.value),
                )
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                {showAvatars ? (
                  <PullRequestActorAvatar
                    actor={
                      option.value === ""
                        ? null
                        : {
                            login: option.label || "?",
                            name: option.label,
                            avatarUrl: option.avatarUrl,
                          }
                    }
                    className="size-3.5"
                  />
                ) : null}
                <span className="min-w-0 max-w-56 flex-1 truncate">{option.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {option.count}
                </span>
              </span>
            </MenuCheckboxItem>
          ))
        )}
      </MenuSubPopup>
    </MenuSub>
  );
}

/**
 * Narrows the loaded rows by assignee, priority, issue type, sprint and status, without asking Jira again. The
 * trigger counts the values chosen, so a narrowed list is never a mystery.
 */
export function JiraIssueFacetsMenu({
  facets,
  selection,
  onChange,
}: {
  facets: JiraIssueFacets;
  selection: JiraIssueFacetSelection;
  onChange: (selection: JiraIssueFacetSelection) => void;
}) {
  const count = countJiraFacetSelection(selection);
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>
        <ListFilterIcon aria-hidden />
        <span>Filters</span>
        {count > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        {FACETS.map((facet) => (
          <JiraFacetSubmenu
            key={facet.key}
            label={facet.label}
            Icon={facet.Icon}
            showAvatars={facet.key === "assignee"}
            options={facets[facet.key]}
            value={selection[facet.key]}
            onChange={(value) => onChange({ ...selection, [facet.key]: value })}
          />
        ))}
        {count > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onChange(EMPTY_JIRA_FACET_SELECTION)}>
              <XIcon aria-hidden />
              Clear filters
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
