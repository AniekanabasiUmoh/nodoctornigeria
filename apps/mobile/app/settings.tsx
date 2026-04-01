import { StyleSheet, Text, View } from "react-native";

import { InfoCard } from "@/components/InfoCard";
import { ScreenShell } from "@/components/ScreenShell";
import { getApiBaseUrl } from "@/lib/api";
import { colors, typography } from "@/lib/theme";

export default function SettingsScreen() {
  return (
    <ScreenShell
      eyebrow="nodoctor.ng — Settings"
      title="Configuration."
      subtitle="API target, environment notes, and build status for this mobile client."
    >
      <InfoCard title="API target">
        <Text style={styles.value}>{getApiBaseUrl()}</Text>
      </InfoCard>
      <InfoCard title="Important" accent="terracotta">
        <View style={styles.list}>
          <Text style={styles.item}>1. Point apiBaseUrl at the deployed nodoctor.ng backend for device testing.</Text>
          <Text style={styles.item}>2. All clinical decision logic runs on the server — never in this app.</Text>
          <Text style={styles.item}>3. Authentication will be added once the backend auth path is settled.</Text>
          <Text style={styles.item}>4. In any emergency, call for help or go to the nearest hospital.</Text>
        </View>
      </InfoCard>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  value: {
    color: colors.ink,
    fontSize: 16,
    lineHeight: 22,
    fontFamily: typography.body
  },
  list: {
    gap: 8
  },
  item: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: typography.body
  }
});

