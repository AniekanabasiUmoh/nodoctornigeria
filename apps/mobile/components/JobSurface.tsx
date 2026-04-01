import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { createVoiceJob, fetchJob } from "@/lib/api";
import { colors, typography } from "@/lib/theme";

export function JobSurface() {
  const [query, setQuery] = useState("My child has diarrhoea and is weak.");
  const [jobId, setJobId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function handleCreateJob() {
    setLoading(true);
    setResult("");
    try {
      const job = await createVoiceJob(query);
      setJobId(job.job_id);
      setStatus(job.status);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Job creation failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    if (!jobId) {
      return;
    }
    setLoading(true);
    try {
      const next = await fetchJob(jobId);
      setStatus(next.status);
      setResult(next.result?.answer ?? "");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Job refresh failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.surface}>
      <TextInput
        multiline
        value={query}
        onChangeText={setQuery}
        style={styles.input}
        placeholder="Describe the voice-note scenario you want the backend to process."
        placeholderTextColor={colors.muted}
      />
      <Pressable style={[styles.button, styles.primaryButton]} onPress={handleCreateJob} disabled={loading}>
        <Text style={styles.primaryButtonLabel}>Create Voice Job</Text>
      </Pressable>
      <Pressable style={[styles.button, styles.secondaryButton]} onPress={handleRefresh} disabled={loading || !jobId}>
        <Text style={styles.secondaryButtonLabel}>Refresh Job Status</Text>
      </Pressable>
      {loading ? <ActivityIndicator color={colors.emerald} /> : null}
      {jobId ? <Text style={styles.meta}>Job ID: {jobId}</Text> : null}
      {status ? <Text style={styles.meta}>Status: {status}</Text> : null}
      {result ? (
        <View style={styles.resultCard}>
          <Text style={styles.resultText}>{result}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    gap: 14
  },
  input: {
    minHeight: 140,
    borderRadius: 22,
    padding: 18,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.ink,
    textAlignVertical: "top",
    fontSize: 16,
    lineHeight: 22,
    fontFamily: typography.body
  },
  button: {
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: "center"
  },
  primaryButton: {
    backgroundColor: colors.emerald
  },
  secondaryButton: {
    backgroundColor: `${colors.gold}22`,
    borderWidth: 1,
    borderColor: `${colors.gold}50`
  },
  primaryButtonLabel: {
    color: "#fff",
    fontSize: 15,
    fontFamily: typography.body
  },
  secondaryButtonLabel: {
    color: colors.ink,
    fontSize: 15,
    fontFamily: typography.body
  },
  meta: {
    color: colors.muted,
    fontSize: 14,
    fontFamily: typography.body
  },
  resultCard: {
    borderRadius: 22,
    padding: 18,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border
  },
  resultText: {
    color: colors.ink,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: typography.body
  }
});

