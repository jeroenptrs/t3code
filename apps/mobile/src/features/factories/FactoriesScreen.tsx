import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { RowPressable } from "../../components/ui/RowPressable";
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
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  const lists = useAtomValue(connectedFactoryListsAtom);
  const { presentationById } = useEnvironments();
  const projects = useProjects();
  const sections = factoryListSections({
    lists,
    environmentLabel: (environmentId) =>
      presentationById.get(environmentId)?.entry.target.label ?? gt("Environment"),
    projectTitle: (environmentId, projectId) =>
      projects.find(
        (project) => project.environmentId === environmentId && project.id === projectId,
      )?.title ?? null,
  });

  return (
    <SettingsScreen title={gt("Factories")}>
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
            title={gt("No factories")}
            detail={gt("Factories from your connected environments show up here.")}
          />
        ) : (
          sections.map((section) => (
            <SettingsSection key={section.environmentId} title={section.title ?? undefined}>
              {section.rows.map(({ factory, projectTitle }, index) => {
                const attention = describeFactoryAttention(factory.attention, messages);
                return (
                  <RowPressable
                    key={factory.id}
                    accessibilityRole="button"
                    accessibilityLabel={[factory.name, projectTitle, attention]
                      .filter(Boolean)
                      .join(", ")}
                    onPress={() =>
                      navigation.navigate("SettingsFactory", {
                        environmentId: section.environmentId,
                        factoryId: factory.id,
                      })
                    }
                    android_ripple={{ color: rippleStyle.backgroundColor }}
                    unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
                    className={
                      index === 0
                        ? "bg-grouped-card"
                        : "border-t border-border-subtle bg-grouped-card"
                    }
                  >
                    <ListRowLayout
                      label={factory.name}
                      description={projectTitle ?? undefined}
                      meta={
                        attention === null ? undefined : (
                          <AppText textRole="footnote" className="text-foreground-muted">
                            {attention}
                          </AppText>
                        )
                      }
                      accessory={
                        <View className="flex-row items-center gap-3">
                          <AttentionBadge count={factory.attention.total} />
                          <SymbolView
                            name="chevron.right"
                            size={16}
                            tintColorClassName="accent-chevron"
                            type="monochrome"
                            weight="semibold"
                          />
                        </View>
                      }
                    />
                  </RowPressable>
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
