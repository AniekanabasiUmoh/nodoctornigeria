import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { InfoCard } from "@/components/InfoCard";
import { ScreenShell } from "@/components/ScreenShell";
import { getApiBaseUrl } from "@/lib/api";
import { colors, typography } from "@/lib/theme";

const routes = [
  {
    href: "/clinical",
    title: "Frontline Clinical",
    description: "Structured answers, referral support, NSTG citations, and deterministic dosing."
  },
  {
    href: "/jobs",
    title: "Voice Jobs",
    description: "Track async voice pipeline jobs and check their status."
  },
  {
    href: "/settings",
    title: "Settings",
    description: "API endpoint, environment, and build configuration."
  }
] as const;

export default function HomeScreen() {
  return (
    <ScreenShell
      eyebrow="nodoctor.ng"
      title="When there is no doctor."
      subtitle="Medical guidance for frontline health workers drawn from the Nigeria Standard Treatment Guidelines."
      footer={<Text style={styles.footer}>API: {getApiBaseUrl()}</Text>}
    >
      <InfoCard title="Frontline support">
        <Text style={styles.bodyText}>
          Use the frontline clinical workspace for assessment, treatment, referral, and dosing support grounded in NSTG guidance.
        </Text>
      </InfoCard>
      <View style={styles.routeGrid}>
        {routes.map((route, index) => (
          <Link href={route.href} asChild key={route.href}>
            <Pressable
              style={[
                styles.routeCard,
                index % 2 === 0 ? styles.routeCardEmerald : styles.routeCardTerracotta
              ]}
            >
              <Text style={styles.routeTitle}>{route.title}</Text>
              <Text style={styles.routeDescription}>{route.description}</Text>
            </Pressable>
          </Link>
        ))}
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  bodyText: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: typography.body
  },
  routeGrid: {
    gap: 14
  },
  routeCard: {
    borderRadius: 24,
    padding: 18,
    borderWidth: 1
  },
  routeCardEmerald: {
    backgroundColor: "#f5fbf8",
    borderColor: "rgba(31, 111, 95, 0.18)"
  },
  routeCardTerracotta: {
    backgroundColor: "#fff7f2",
    borderColor: "rgba(201, 108, 67, 0.18)"
  },
  routeTitle: {
    color: colors.ink,
    fontSize: 24,
    marginBottom: 8,
    fontFamily: typography.display
  },
  routeDescription: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 21,
    fontFamily: typography.body
  },
  footer: {
    color: colors.muted,
    fontSize: 14,
    fontFamily: typography.body
  }
});
