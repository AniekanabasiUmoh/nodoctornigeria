from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock
from uuid import uuid4

import httpx

from .api_models import JobStatusResponse, QueryResponse


@dataclass(slots=True)
class JobRequest:
    job_id: str
    channel: str
    query: str
    top_k: int


@dataclass(slots=True)
class InMemoryJobRecord:
    request: JobRequest
    status: str
    result: QueryResponse | None = None
    error: str | None = None
    attempt_count: int = 0


class InMemoryJobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, InMemoryJobRecord] = {}
        self._lock = Lock()

    def create_job(self, *, query: str, top_k: int, channel: str = "community_voice_job") -> JobStatusResponse:
        request = JobRequest(job_id=uuid4().hex, channel=channel, query=query, top_k=top_k)
        record = InMemoryJobRecord(request=request, status="queued")
        with self._lock:
            self._jobs[request.job_id] = record
        return self._to_status(record)

    def get_request(self, job_id: str) -> JobRequest | None:
        with self._lock:
            record = self._jobs.get(job_id)
            return record.request if record else None

    def mark_running(self, job_id: str) -> None:
        with self._lock:
            record = self._jobs[job_id]
            record.status = "running"
            record.result = None
            record.error = None
            record.attempt_count += 1

    def mark_complete(self, job_id: str, result: QueryResponse) -> None:
        with self._lock:
            record = self._jobs[job_id]
            record.status = "completed"
            record.result = result
            record.error = None

    def mark_failed(self, job_id: str, error: str) -> None:
        with self._lock:
            record = self._jobs[job_id]
            record.status = "failed"
            record.result = None
            record.error = error

    def get(self, job_id: str) -> JobStatusResponse | None:
        with self._lock:
            record = self._jobs.get(job_id)
            return self._to_status(record) if record else None

    def _to_status(self, record: InMemoryJobRecord) -> JobStatusResponse:
        return JobStatusResponse(
            job_id=record.request.job_id,
            status=record.status,
            result=record.result,
            error=record.error,
        )


class SupabaseJobStore:
    def __init__(self, *, supabase_url: str, service_role_key: str) -> None:
        self.supabase_url = supabase_url.rstrip("/")
        self.service_role_key = service_role_key
        self._headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def create_job(self, *, query: str, top_k: int, channel: str = "community_voice_job") -> JobStatusResponse:
        payload = {
            "job_id": uuid4().hex,
            "channel": channel,
            "query": query,
            "top_k": top_k,
            "status": "queued",
            "created_at": datetime.now(UTC).isoformat(),
            "updated_at": datetime.now(UTC).isoformat(),
            "attempt_count": 0,
            "last_error": None,
            "result": None,
        }
        row = self._insert_job(payload)
        return self._job_from_row(row)

    def get_request(self, job_id: str) -> JobRequest | None:
        row = self._fetch_row(job_id, "job_id,channel,query,top_k")
        if row is None:
            return None
        return JobRequest(
            job_id=str(row["job_id"]),
            channel=str(row.get("channel") or "community_voice_job"),
            query=str(row.get("query") or ""),
            top_k=int(row.get("top_k") or 4),
        )

    def mark_running(self, job_id: str) -> None:
        row = self._fetch_row(job_id, "attempt_count")
        if row is None:
            raise KeyError(job_id)
        self._patch_job(
            job_id,
            {
                "status": "running",
                "updated_at": datetime.now(UTC).isoformat(),
                "attempt_count": int(row.get("attempt_count") or 0) + 1,
                "last_error": None,
                "result": None,
            },
        )

    def mark_complete(self, job_id: str, result: QueryResponse) -> None:
        self._patch_job(
            job_id,
            {
                "status": "completed",
                "updated_at": datetime.now(UTC).isoformat(),
                "last_error": None,
                "result": result.model_dump(mode="json"),
            },
        )

    def mark_failed(self, job_id: str, error: str) -> None:
        self._patch_job(
            job_id,
            {
                "status": "failed",
                "updated_at": datetime.now(UTC).isoformat(),
                "last_error": error,
                "result": None,
            },
        )

    def get(self, job_id: str) -> JobStatusResponse | None:
        row = self._fetch_row(job_id, "job_id,status,result,last_error")
        if row is None:
            return None
        return self._job_from_row(row)

    def _insert_job(self, payload: dict[str, object]) -> dict[str, object]:
        url = f"{self.supabase_url}/rest/v1/async_jobs"
        with httpx.Client(timeout=20.0) as client:
            response = client.post(url, headers={**self._headers, "Prefer": "return=representation"}, json=payload)
            response.raise_for_status()
        return response.json()[0]

    def _patch_job(self, job_id: str, payload: dict[str, object]) -> None:
        url = f"{self.supabase_url}/rest/v1/async_jobs"
        with httpx.Client(timeout=20.0) as client:
            response = client.patch(
                url,
                headers={**self._headers, "Prefer": "return=minimal"},
                params={"job_id": f"eq.{job_id}"},
                json=payload,
            )
            response.raise_for_status()

    def _fetch_row(self, job_id: str, select: str) -> dict[str, object] | None:
        url = f"{self.supabase_url}/rest/v1/async_jobs"
        with httpx.Client(timeout=20.0) as client:
            response = client.get(
                url,
                headers=self._headers,
                params={"job_id": f"eq.{job_id}", "select": select},
            )
            response.raise_for_status()
        rows = response.json()
        if not rows:
            return None
        return rows[0]

    def _job_from_row(self, row: dict[str, object]) -> JobStatusResponse:
        return JobStatusResponse(
            job_id=str(row["job_id"]),
            status=str(row["status"]),
            result=QueryResponse.model_validate(row["result"]) if row.get("result") else None,
            error=str(row["last_error"]) if row.get("last_error") else None,
        )
