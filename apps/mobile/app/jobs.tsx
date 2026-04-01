import { Text, StyleSheet } from "react-native";

import { InfoCard } from "@/components/InfoCard";
import { JobSurface } from "@/components/JobSurface";
import { ScreenShell } from "@/components/ScreenShell";
import { colors, typography } from "@/lib/theme";

export default function JobsScreen() {
  return (
    <ScreenShell
      eyebrow="nodoctor.ng — Voice Jobs"
      title="Voice pipeline status."
      subtitle="Submit a voice query and track it here. The system acknowledges immediately and processes in the background."
    >
      <InfoCard title="How it works" accent="emerald">
        <Text style={styles.copy}>
          Voice queries are queued and processed asynchronously. You receive an acknowledgment right away, and the answer appears here when ready.
        </Text>
      </InfoCard>
      <JobSurface />
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

