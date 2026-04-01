import Constants from "expo-constants";

type QueryMode = "community" | "clinical";

export type QueryResponse = {
  interaction_id?: string | null;
  answer: string;
  disposition: string;
  triage?: string | null;
  warnings: string[];
  citations: Array<{
    source_file?: string | null;
    condition: string;
    section?: string | null;
    subsection?: string | null;
    page?: number | null;
  }>;
  dosage?: {
    medication?: string | null;
    weight_kg?: number | null;
    formula?: string | null;
    dose_mg?: number | null;
    dose_range_mg?: number[] | null;
    note?: string | null;
  } | null;
};

type JobStatus = {
  job_id: string;
  status: string;
  result?: QueryResponse | null;
};

const apiBaseUrl =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined)?.replace(/\/+$/, "") ||
  "http://127.0.0.1:8000";

async function postJson<T>(path: string, payload: object): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function submitQuery(mode: QueryMode, query: string): Promise<QueryResponse> {
  const path = mode === "community" ? "/api/community/query" : "/api/clinical/query";
  return postJson<QueryResponse>(path, { query, top_k: mode === "community" ? 4 : 5 });
}

export async function createVoiceJob(query: string): Promise<JobStatus> {
  return postJson<JobStatus>("/api/community/voice-jobs", { query, top_k: 4 });
}

export async function fetchJob(jobId: string): Promise<JobStatus> {
  return getJson<JobStatus>(`/api/jobs/${jobId}`);
}

export async function submitFeedback(interactionId: string, rating: "up" | "down", comment?: string): Promise<void> {
  await postJson("/api/feedback", { interaction_id: interactionId, rating, comment });
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

