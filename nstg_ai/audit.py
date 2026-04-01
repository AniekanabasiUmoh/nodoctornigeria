from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from uuid import uuid4

import httpx

from .api_models import (
    AuditInteractionRecord,
    AuditTrace,
    FeedbackRequest,
    FeedbackResponse,
    QueryResponse,
)


class JsonlAuditStore:
    def __init__(self, storage_dir: str | Path) -> None:
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.interactions_path = self.storage_dir / "interactions.jsonl"
        self.feedback_path = self.storage_dir / "feedback.jsonl"
        self._lock = Lock()
        self._ensure_files()

    def log_interaction(
        self,
        *,
        route: str,
        channel: str,
        query: str,
        top_k: int,
        response: QueryResponse,
        trace: AuditTrace,
        job_id: str | None = None,
    ) -> str:
        interaction_id = uuid4().hex
        payload = {
            "interaction_id": interaction_id,
            "created_at": datetime.now(UTC).isoformat(),
            "route": route,
            "channel": channel,
            "query": query,
            "normalized_query": trace.normalized_query,
            "top_k": top_k,
            "job_id": job_id,
            "response": response.model_dump(mode="json"),
            "trace": trace.model_dump(mode="json"),
            "review_required": trace.review_required,
            "review_status": trace.operator_review_status,
        }
        with self._lock:
            self._append_jsonl(self.interactions_path, payload)
        return interaction_id

    def log_feedback(self, feedback: FeedbackRequest) -> FeedbackResponse:
        with self._lock:
            if not self._interaction_exists(feedback.interaction_id):
                raise ValueError("interaction_id was not found in the audit log.")

            feedback_id = uuid4().hex
            payload = {
                "feedback_id": feedback_id,
                "interaction_id": feedback.interaction_id,
                "created_at": datetime.now(UTC).isoformat(),
                "rating": feedback.rating,
                "comment": feedback.comment,
            }
            self._append_jsonl(self.feedback_path, payload)

        return FeedbackResponse(
            feedback_id=feedback_id,
            interaction_id=feedback.interaction_id,
            rating=feedback.rating,
        )

    def count_interactions(self) -> int:
        with self._lock:
            return self._count_lines(self.interactions_path)

    def count_feedback(self) -> int:
        with self._lock:
            return self._count_lines(self.feedback_path)

    def clear_all(self) -> None:
        with self._lock:
            self.interactions_path.write_text("", encoding="utf-8")
            self.feedback_path.write_text("", encoding="utf-8")

    def latest_interaction(self) -> dict[str, object] | None:
        with self._lock:
            rows = self._read_jsonl(self.interactions_path)
        return rows[-1] if rows else None

    def list_interactions(
        self,
        *,
        limit: int = 20,
        review_required_only: bool = False,
    ) -> list[AuditInteractionRecord]:
        with self._lock:
            rows = list(reversed(self._read_jsonl(self.interactions_path)))
        if review_required_only:
            rows = [row for row in rows if row.get("review_required")]
        return [self._parse_interaction(row) for row in rows[:limit]]

    def update_review_status(self, interaction_id: str, review_status: str) -> AuditInteractionRecord:
        with self._lock:
            rows = self._read_jsonl(self.interactions_path)
            updated_row: dict[str, object] | None = None
            for row in rows:
                if row.get("interaction_id") != interaction_id:
                    continue
                row["review_status"] = review_status
                trace = row.get("trace")
                if not isinstance(trace, dict):
                    trace = {}
                trace["operator_review_status"] = review_status
                row["trace"] = trace
                updated_row = row
                break
            if updated_row is None:
                raise ValueError("interaction_id was not found in the audit log.")
            self._rewrite_jsonl(self.interactions_path, rows)
        return self._parse_interaction(updated_row)

    def _ensure_files(self) -> None:
        if not self.interactions_path.exists():
            self.interactions_path.write_text("", encoding="utf-8")
        if not self.feedback_path.exists():
            self.feedback_path.write_text("", encoding="utf-8")

    def _append_jsonl(self, path: Path, payload: dict[str, object]) -> None:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=True))
            handle.write("\n")

    def _rewrite_jsonl(self, path: Path, rows: list[dict[str, object]]) -> None:
        with path.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=True))
                handle.write("\n")

    def _interaction_exists(self, interaction_id: str) -> bool:
        for payload in self._read_jsonl(self.interactions_path):
            if payload.get("interaction_id") == interaction_id:
                return True
        return False

    def _count_lines(self, path: Path) -> int:
        with path.open("r", encoding="utf-8") as handle:
            return sum(1 for line in handle if line.strip())

    def _read_jsonl(self, path: Path) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                rows.append(json.loads(line))
        return rows

    def _parse_interaction(self, payload: dict[str, object]) -> AuditInteractionRecord:
        return AuditInteractionRecord.model_validate(payload)


class SupabaseAuditStore:
    def __init__(self, *, supabase_url: str, service_role_key: str, schema: str = "public") -> None:
        self.supabase_url = supabase_url.rstrip("/")
        self.service_role_key = service_role_key
        self.schema = schema
        self._headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def log_interaction(
        self,
        *,
        route: str,
        channel: str,
        query: str,
        top_k: int,
        response: QueryResponse,
        trace: AuditTrace,
        job_id: str | None = None,
    ) -> str:
        interaction_id = uuid4().hex
        payload = {
            "interaction_id": interaction_id,
            "created_at": datetime.now(UTC).isoformat(),
            "route": route,
            "channel": channel,
            "query": query,
            "normalized_query": trace.normalized_query,
            "top_k": top_k,
            "job_id": job_id,
            "response": response.model_dump(mode="json"),
            "trace": trace.model_dump(mode="json"),
            "review_required": trace.review_required,
            "review_status": trace.operator_review_status,
        }
        self._post("audit_interactions", payload)
        return interaction_id

    def log_feedback(self, feedback: FeedbackRequest) -> FeedbackResponse:
        feedback_id = uuid4().hex
        payload = {
            "feedback_id": feedback_id,
            "interaction_id": feedback.interaction_id,
            "created_at": datetime.now(UTC).isoformat(),
            "rating": feedback.rating,
            "comment": feedback.comment,
        }
        self._post("feedback_events", payload)
        return FeedbackResponse(
            feedback_id=feedback_id,
            interaction_id=feedback.interaction_id,
            rating=feedback.rating,
        )

    def count_interactions(self) -> int:
        return 0

    def count_feedback(self) -> int:
        return 0

    def clear_all(self) -> None:
        raise RuntimeError("clear_all is not supported for the Supabase audit provider.")

    def latest_interaction(self) -> dict[str, object] | None:
        records = self.list_interactions(limit=1)
        if not records:
            return None
        return records[0].model_dump(mode="json")

    def list_interactions(
        self,
        *,
        limit: int = 20,
        review_required_only: bool = False,
    ) -> list[AuditInteractionRecord]:
        params = {
            "select": "interaction_id,created_at,route,channel,query,normalized_query,top_k,job_id,response,trace,review_required,review_status",
            "order": "created_at.desc",
            "limit": str(limit),
        }
        if review_required_only:
            params["review_required"] = "eq.true"
        rows = self._get("audit_interactions", params)
        return [AuditInteractionRecord.model_validate(row) for row in rows]

    def update_review_status(self, interaction_id: str, review_status: str) -> AuditInteractionRecord:
        current = self._get_interaction(interaction_id)
        if current is None:
            raise ValueError("interaction_id was not found in the audit log.")

        trace = current.trace.model_dump(mode="json")
        trace["operator_review_status"] = review_status
        url = f"{self.supabase_url}/rest/v1/audit_interactions"
        with httpx.Client(timeout=20.0) as client:
            response = client.patch(
                url,
                headers={**self._headers, "Prefer": "return=minimal"},
                params={"interaction_id": f"eq.{interaction_id}"},
                json={"review_status": review_status, "trace": trace},
            )
            response.raise_for_status()

        updated = self._get_interaction(interaction_id)
        if updated is None:
            raise RuntimeError("Updated interaction could not be reloaded from Supabase.")
        return updated

    def _post(self, table: str, payload: dict[str, object]) -> None:
        url = f"{self.supabase_url}/rest/v1/{table}"
        with httpx.Client(timeout=20.0) as client:
            response = client.post(url, headers={**self._headers, "Prefer": "return=minimal"}, json=payload)
            response.raise_for_status()

    def _get(self, table: str, params: dict[str, str]) -> list[dict[str, object]]:
        url = f"{self.supabase_url}/rest/v1/{table}"
        with httpx.Client(timeout=20.0) as client:
            response = client.get(url, headers=self._headers, params=params)
            response.raise_for_status()
        data = response.json()
        if not isinstance(data, list):
            raise RuntimeError(f"Expected list response from {table}.")
        return data

    def _get_interaction(self, interaction_id: str) -> AuditInteractionRecord | None:
        rows = self._get(
            "audit_interactions",
            {
                "select": "interaction_id,created_at,route,channel,query,normalized_query,top_k,job_id,response,trace,review_required,review_status",
                "interaction_id": f"eq.{interaction_id}",
                "limit": "1",
            },
        )
        if not rows:
            return None
        return AuditInteractionRecord.model_validate(rows[0])
