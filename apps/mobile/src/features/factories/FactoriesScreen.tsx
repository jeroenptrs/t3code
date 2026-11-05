import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { connectedFactoryListsAtom } from "../../state/factories";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  describeFactoryAttention,
  factoryAttentionTotal,
  factoryListSections,
  hasFactories,
} from "./FactoriesScreen.logic";

/** For the entry point: whether to show it, and the attention count it carries. */
export function useFactoriesEntry() {
  const visible = useAtomValue(connectedFactoryListsAtom, hasFactories);
  const attention = useAtomValue(connectedFactoryListsAtom, factoryAttentionTotal);
  return { visible, attention };
}

export function FactoriesScreen() {
  const insets = useSafeAreaInsets();
  const lists = useAtomValue(connectedFactoryListsAtom);
  const { presentationById } = useEnvironments();
  const projects = useProjects();
  const sections = factoryListSections({
    lists,
    environmentLabel: (environmentId) =>
      presentationById.get(environmentId)?.entry.target.label ?? "Environment",
    projectTitle: (environmentId, projectId) =>
      projects.find(
        (project) => project.environmentId === environmentId && project.id === projectId,
      )?.title ?? null,
  });

  return (
    <SettingsScreen title="Factories">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {sections.length === 0 ? (
          <EmptyState
            variant="plain"
            title="No factories"
            detail="Factories from your connected environments show up here."
          />
        ) : (
          sections.map((section) => (
            <SettingsSection key={section.environmentId} title={section.title ?? undefined}>
              {section.rows.map(({ factory, projectTitle }) => {
                const attention = describeFactoryAttention(factory.attention);
                const description = projectTitle ? `${projectTitle} · ${attention}` : attention;
                return (
                  <View
                    key={factory.id}
                    accessible
                    accessibilityLabel={`${factory.name}, ${description}`}
                  >
                    <ListRowLayout
                      label={factory.name}
                      description={description}
                      accessory={<AttentionBadge count={factory.attention.total} />}
                    />
                  </View>
                );
              })}
            </SettingsSection>
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function AttentionBadge(props: { readonly count: number }) {
  if (props.count === 0) return null;
  return (
    <View className="min-w-6 items-center rounded-full bg-primary px-2 py-0.5">
      <AppText className="text-xs font-t3-bold text-primary-foreground">{props.count}</AppText>
    </View>
  );
}
