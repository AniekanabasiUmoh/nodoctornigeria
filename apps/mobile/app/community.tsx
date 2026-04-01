import { Text, StyleSheet } from "react-native";

import { InfoCard } from "@/components/InfoCard";
import { QuerySurface } from "@/components/QuerySurface";
import { ScreenShell } from "@/components/ScreenShell";
import { colors, typography } from "@/lib/theme";

export default function CommunityScreen() {
  return (
    <ScreenShell
      eyebrow="nodoctor.ng &mdash; Community"
      title="Health guidance in plain language."
      subtitle="Ask about symptoms, treatments, or what to do. Danger signs are flagged immediately."
    >
      <InfoCard title="Safety first" accent="terracotta">
        <Text style={styles.copy}>
          In an emergency — unconsciousness, convulsions, heavy bleeding, difficulty breathing — go to the nearest hospital immediately. Do not wait for an AI response.
        </Text>
      </InfoCard>
      <QuerySurface
        mode="community"
        initialQuery="What helps acute diarrhoea in a child?"
        placeholder="Ask in plain language. E.g. My child has fever and is not eating."
      />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  copy: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: typography.body
  }
});

