import { startTransition, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { submitFeedback, submitQuery, QueryResponse } from "@/lib/api";
import { colors, typography } from "@/lib/theme";

type QuerySurfaceProps = {
  mode: "community" | "clinical";
  placeholder: string;
  initialQuery: string;
};

export function QuerySurface({ mode, placeholder, initialQuery }: QuerySurfaceProps) {
  const [query, setQuery] = useState(initialQuery);
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedbackState, setFeedbackState] = useState<string>("");
  const [error, setError] = useState<string>("");

  async function handleSubmit() {
    setLoading(true);
    setError("");
    setFeedbackState("");

    try {
      const next = await submitQuery(mode, query);
      startTransition(() => {
        setResponse(next);
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Request failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleFeedback(rating: "up" | "down") {
    if (!response?.interaction_id) {
      return;
    }

    try {
      await submitFeedback(response.interaction_id, rating);
      setFeedbackState(rating === "up" ? "Marked helpful." : "Marked for review.");
    } catch (feedbackError) {
      setFeedbackState(feedbackError instanceof Error ? feedbackError.message : "Feedback failed.");
    }
  }

  return (
    <View style={styles.surface}>
      <TextInput
        multiline
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
      />
      <Pressable style={[styles.button, styles.primaryButton]} onPress={handleSubmit} disabled={loading}>
        <Text style={styles.primaryButtonLabel}>{loading ? "Working..." : "Send Query"}</Text>
      </Pressable>
      {loading ? <ActivityIndicator color={colors.emerald} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {response ? (
        <View style={styles.responseCard}>
          <Text style={styles.responseHeading}>Answer</Text>
          <Text style={styles.responseText}>{response.answer}</Text>
          <Text style={styles.meta}>
            Disposition: {response.disposition}
            {response.triage ? `  |  Triage: ${response.triage}` : ""}
          </Text>
          {response.dosage?.dose_mg != null ? (
            <Text style={styles.meta}>Dose: {response.dosage.dose_mg} mg</Text>
          ) : null}
          {response.dosage?.dose_range_mg?.length === 2 ? (
            <Text style={styles.meta}>
              Dose range: {response.dosage.dose_range_mg[0]}-{response.dosage.dose_range_mg[1]} mg
            </Text>
          ) : null}
          <Text style={styles.responseHeading}>Citations</Text>
          {response.citations.map((citation, index) => (
            <Text style={styles.citation} key={`${citation.condition}-${citation.section}-${index}`}>
              {citation.condition}
              {citation.section ? ` -> ${citation.section}` : ""}
              {citation.subsection ? ` -> ${citation.subsection}` : ""}
            </Text>
          ))}
          <View style={styles.feedbackRow}>
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={() => handleFeedback("up")}>
              <Text style={styles.secondaryButtonLabel}>Helpful</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={() => handleFeedback("down")}>
              <Text style={styles.secondaryButtonLabel}>Needs Review</Text>
            </Pressable>
          </View>
          {feedbackState ? <Text style={styles.meta}>{feedbackState}</Text> : null}
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
    minHeight: 150,
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
    backgroundColor: `${colors.terracotta}18`,
    borderWidth: 1,
    borderColor: `${colors.terracotta}33`
  },
  primaryButtonLabel: {
    color: "#fff",
    fontSize: 15,
    fontFamily: typography.body
  },
  secondaryButtonLabel: {
    color: colors.terracotta,
    fontSize: 14,
    fontFamily: typography.body
  },
  responseCard: {
    borderRadius: 22,
    padding: 18,
    backgroundColor: colors.code,
    gap: 10
  },
  responseHeading: {
    color: "#d8eadf",
    fontSize: 13,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontFamily: typography.body
  },
  responseText: {
    color: "#f4f8f2",
    fontSize: 15,
    lineHeight: 22,
    fontFamily: typography.body
  },
  meta: {
    color: "#b8cabf",
    fontSize: 13,
    lineHeight: 18,
    fontFamily: typography.body
  },
  citation: {
    color: "#d8eadf",
    fontSize: 13,
    lineHeight: 18,
    fontFamily: typography.body
  },
  feedbackRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    fontFamily: typography.body
  }
});

