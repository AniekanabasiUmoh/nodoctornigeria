import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ExtractedPatientFacts, SessionMemory, SessionTurn } from "./types.ts";

const SESSION_TTL_HOURS = 4;
const MAX_TURNS_STORED = 5;
const NULLABLE_FACT_KEYS = new Set(["last_clarification", "caregiver_relationship", "speaker_role", "patient_age_group", "active_condition", "active_task"]);

export async function loadSessionMemory(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<SessionMemory | null> {
  try {
    const { data, error } = await supabase
      .from("session_memory")
      .select("session_id,channel,turn_count,facts,recent_turns,updated_at")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (error || !data) return null;

    // Expire sessions idle for more than TTL
    const ageHours = (Date.now() - new Date(data.updated_at).getTime()) / 3_600_000;
    if (ageHours > SESSION_TTL_HOURS) return null;

    return data as SessionMemory;
  } catch {
    return null;
  }
}

export async function clearSessionMemory(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  try {
    await supabase.from("session_memory").delete().eq("session_id", sessionId);
  } catch {
    // Non-fatal
  }
}

export async function saveSessionMemory(
  supabase: SupabaseClient,
  sessionId: string,
  channel: string,
  newTurn: SessionTurn,
  newFacts: ExtractedPatientFacts,
  existingMemory: SessionMemory | null,
): Promise<void> {
  try {
    const previousTurns: SessionTurn[] = existingMemory?.recent_turns ?? [];
    const mergedTurns = [...previousTurns, newTurn].slice(-MAX_TURNS_STORED);

    // Merge facts: new non-null values override, known values are preserved
    const existingFacts = existingMemory?.facts ?? {};
    const mergedFacts: ExtractedPatientFacts = { ...existingFacts };
    for (const [key, value] of Object.entries(newFacts)) {
      if (value == null) {
        if (NULLABLE_FACT_KEYS.has(key)) {
          (mergedFacts as Record<string, unknown>)[key] = null;
        }
        continue;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        (mergedFacts as Record<string, unknown>)[key] = [...new Set(value)];
        continue;
      }
      (mergedFacts as Record<string, unknown>)[key] = value;
    }

    const { error } = await supabase
      .from("session_memory")
      .upsert({
        session_id: sessionId,
        channel,
        turn_count: (existingMemory?.turn_count ?? 0) + 1,
        facts: mergedFacts,
        recent_turns: mergedTurns,
        updated_at: new Date().toISOString(),
      }, { onConflict: "session_id" });

    if (error) {
      console.warn("session_memory upsert failed:", error.message);
    }
  } catch (err) {
    // Non-fatal: memory failure must not kill the response
    console.warn("session_memory save error:", err instanceof Error ? err.message : String(err));
  }
}
