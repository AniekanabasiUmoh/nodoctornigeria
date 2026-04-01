export type QueryMode = "community" | "clinical";

export type Citation = {
  source_file?: string | null;
  condition: string;
  section?: string | null;
  subsection?: string | null;
  page?: number | null;
};

export type DosageResult = {
  medication?: string | null;
  weight_kg?: number | null;
  formula?: string | null;
  dose_mg?: number | null;
  dose_range_mg?: number[] | null;
  note?: string | null;
};

export type QueryResponse = {
  interaction_id?: string | null;
  answer: string;
  disposition: string;
  follow_up_question?: string | null;
  triage?: string | null;
  citations: Citation[];
  warnings: string[];
  dosage?: DosageResult | null;
};

export type JobStatus = {
  job_id: string;
  status: string;
  result?: QueryResponse | null;
  error?: string | null;
};

const base = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");

async function post<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

function cleanQuery(query: string): string {
  return query.replace(/^\/(clinical|community)\s*/i, "").trim();
}

export function submitQuery(mode: QueryMode, query: string): Promise<QueryResponse> {
  const path = mode === "community" ? "/community/query" : "/clinical/query";
  return post<QueryResponse>(path, { query: cleanQuery(query), top_k: mode === "community" ? 4 : 5 });
}

export function submitFeedback(interactionId: string, rating: "up" | "down"): Promise<void> {
  return post("/feedback", { interaction_id: interactionId, rating });
}

export function createVoiceJob(query: string): Promise<JobStatus> {
  return post<JobStatus>("/community/voice-jobs", { query, top_k: 4 });
}

export function fetchJob(jobId: string): Promise<JobStatus> {
  return get<JobStatus>(`/jobs/${jobId}`);
}
