import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { FactoryAttentionBadge } from "./FactoryAttentionBadge";
import type { SidebarTab } from "./useSidebarFactories";

/** Home and Factories, each with the attention its threads need. */
export function SidebarTabs(props: {
  readonly tab: SidebarTab;
  readonly homeAttention: number;
  readonly factoriesAttention: number;
  readonly onTabChange: (tab: SidebarTab) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Sidebar view"
      variant="segmented"
      className="mb-1.5 w-full"
      value={[props.tab]}
      onValueChange={(next) => {
        const tab = next[0];
        if (tab === "home" || tab === "factories") props.onTabChange(tab);
      }}
    >
      <Toggle value="home" className="flex-1">
        Home
        <FactoryAttentionBadge count={props.homeAttention} />
      </Toggle>
      <Toggle value="factories" className="flex-1">
        Factories
        <FactoryAttentionBadge count={props.factoriesAttention} />
      </Toggle>
    </ToggleGroup>
  );
}
