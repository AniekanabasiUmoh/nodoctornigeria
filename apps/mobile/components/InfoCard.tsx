import { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, typography } from "@/lib/theme";

type InfoCardProps = {
  title: string;
  accent?: "emerald" | "terracotta" | "gold";
  children: ReactNode;
};

export function InfoCard({ title, accent = "emerald", children }: InfoCardProps) {
  const accentColor =
    accent === "terracotta" ? colors.terracotta : accent === "gold" ? colors.gold : colors.emerald;

  return (
    <View style={styles.card}>
      <View style={[styles.badge, { backgroundColor: `${accentColor}1A` }]}>
        <Text style={[styles.badgeText, { color: accentColor }]}>{title}</Text>
      </View>
      <View>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 22,
    padding: 18,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 14
  },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999
  },
  badgeText: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontFamily: typography.body
  }
});

