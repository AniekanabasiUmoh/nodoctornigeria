from __future__ import annotations

import argparse
from urllib.parse import urlparse
from pathlib import Path

import httpx

from .pipeline import (
    build_chunks,
    build_condition_directory_chunks,
    load_document,
    write_chunks_jsonl,
)
from .evaluation import run_default_evaluation
from .phase1 import build_phase1_audit_report, write_phase1_audit_report
from .settings import get_settings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="NSTG Medical AI Assistant CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_chunks_parser = subparsers.add_parser(
        "build-chunks",
        help="Validate structured NSTG JSON and emit chunked JSONL output.",
    )
    build_chunks_parser.add_argument("--input", required=True, help="Path to the structured NSTG JSON file.")
    build_chunks_parser.add_argument("--output", required=True, help="Path to the output JSONL file.")

    build_dataset_parser = subparsers.add_parser(
        "build-dataset-chunks",
        help="Validate the processed NSTG condition dataset and emit chunked JSONL output.",
    )
    build_dataset_parser.add_argument("--input-dir", required=True, help="Path to the processed_json directory.")
    build_dataset_parser.add_argument("--output", required=True, help="Path to the output JSONL file.")

    evaluate_parser = subparsers.add_parser(
        "evaluate",
        help="Run the local Phase 3 evaluation harness and write a JSON report.",
    )
    evaluate_parser.add_argument("--cases", required=True, help="Path to the evaluation cases JSON file.")
    evaluate_parser.add_argument("--output", required=True, help="Path to the output evaluation report JSON file.")

    phase1_audit_parser = subparsers.add_parser(
        "phase1-audit",
        help="Audit the structured NSTG dataset and write a Phase 1 data-quality report.",
    )
    phase1_audit_parser.add_argument(
        "--input-dir",
        required=True,
        help="Path to the processed_json directory.",
    )
    phase1_audit_parser.add_argument(
        "--raw-text-dir",
        help="Optional path to the raw NSTG text files for source coverage checks.",
    )
    phase1_audit_parser.add_argument(
        "--output",
        required=True,
        help="Path to the output report JSON file.",
    )

    ingest_parser = subparsers.add_parser(
        "ingest-chunks",
        help="Upsert guideline chunks from a JSONL file into the Supabase guideline_chunks table.",
    )
    ingest_parser.add_argument("--input", required=True, help="Path to the chunks JSONL file.")
    ingest_parser.add_argument(
        "--batch-size",
        type=int,
        default=200,
        help="Number of rows per upsert batch (default: 200).",
    )

    telegram_webhook_parser = subparsers.add_parser(
        "telegram-webhook",
        help="Manage the public Telegram webhook for this bot.",
    )
    telegram_webhook_parser.add_argument(
        "--action",
        choices=("set", "info", "delete"),
        default="info",
        help="Whether to register, inspect, or remove the Telegram webhook.",
    )
    telegram_webhook_parser.add_argument(
        "--base-url",
        help="Public HTTPS base URL of the deployed backend. Falls back to PUBLIC_BASE_URL from .env.",
    )
    telegram_webhook_parser.add_argument(
        "--route",
        choices=("community", "clinical", "legacy"),
        default="legacy",
        help="Webhook route to manage. Use community or clinical for separate bots, or legacy for the command-routed endpoint.",
    )

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "build-chunks":
        document = load_document(args.input)
        chunks = build_chunks(document)
        output_path = write_chunks_jsonl(chunks, args.output)
        print(f"Validated document: {document.title}")
        print(f"Generated chunks: {len(chunks)}")
        print(f"Wrote output: {Path(output_path).resolve()}")
    elif args.command == "build-dataset-chunks":
        chunks = build_condition_directory_chunks(args.input_dir)
        output_path = write_chunks_jsonl(chunks, args.output)
        print(f"Validated dataset directory: {Path(args.input_dir).resolve()}")
        print(f"Generated chunks: {len(chunks)}")
        print(f"Wrote output: {Path(output_path).resolve()}")
    elif args.command == "evaluate":
        output_path = run_default_evaluation(cases_path=args.cases, output_path=args.output)
        print(f"Wrote evaluation report: {Path(output_path).resolve()}")
    elif args.command == "phase1-audit":
        report = build_phase1_audit_report(
            processed_json_dir=args.input_dir,
            raw_text_dir=args.raw_text_dir,
        )
        output_path = write_phase1_audit_report(report, args.output)
        print(f"Audited conditions: {report.total_conditions}")
        print(f"Raw text coverage ratio: {report.source_coverage_ratio}")
        print(f"Generated chunks: {report.total_chunks}")
        print(f"Duplicate chunk IDs: {report.duplicate_chunk_ids}")
        print(f"Wrote Phase 1 audit report: {Path(output_path).resolve()}")
    elif args.command == "ingest-chunks":
        _handle_ingest_chunks(args)
    elif args.command == "telegram-webhook":
        _handle_telegram_webhook(args)


def _handle_ingest_chunks(args: argparse.Namespace) -> None:
    import json

    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env to ingest chunks.")

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}")

    rows_by_id: dict[str, dict] = {}
    with input_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            rows_by_id[record["chunk_id"]] = {
                "chunk_id": record["chunk_id"],
                "text": record["text"],
                "word_count": record["word_count"],
                "metadata": record["metadata"],
            }

    rows = list(rows_by_id.values())
    total = len(rows)
    batch_size = args.batch_size
    url = settings.supabase_url.rstrip("/") + "/rest/v1/guideline_chunks"
    headers = {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }
    if settings.supabase_schema != "public":
        headers["Accept-Profile"] = settings.supabase_schema
        headers["Content-Profile"] = settings.supabase_schema

    upserted = 0
    with httpx.Client(timeout=60.0) as client:
        for start in range(0, total, batch_size):
            batch = rows[start : start + batch_size]
            response = client.post(url, headers=headers, json=batch)
            response.raise_for_status()
            upserted += len(batch)
            print(f"  Upserted {upserted}/{total} chunks...")

    print(f"Done. {total} unique chunks upserted into guideline_chunks.")


def _handle_telegram_webhook(args: argparse.Namespace) -> None:
    settings = get_settings()
    route = args.route
    if route == "clinical":
        bot_token = settings.telegram_bot_token_clinical
        if not bot_token:
            raise SystemExit("TELEGRAM_BOT_TOKEN_CLINICAL is not configured in .env.")
    else:
        bot_token = settings.telegram_bot_token
        if not bot_token:
            raise SystemExit("TELEGRAM_BOT_TOKEN is not configured in .env.")

    if args.action == "set":
        webhook_url = _resolve_webhook_url(args.base_url or settings.public_base_url, route=route)
        payload = {"url": webhook_url}
        if settings.telegram_webhook_secret:
            payload["secret_token"] = settings.telegram_webhook_secret
        result = _telegram_api_call(bot_token, "setWebhook", payload)
        print(f"Webhook registered: {webhook_url}")
        print(f"Telegram response: {result.get('description', 'ok')}")
        return

    if args.action == "delete":
        result = _telegram_api_call(bot_token, "deleteWebhook", {})
        print(f"Webhook removed. Telegram response: {result.get('description', 'ok')}")
        return

    result = _telegram_api_call(bot_token, "getWebhookInfo", {})
    print("Current Telegram webhook info:")
    print(f"  url: {result.get('url') or '(not set)'}")
    print(f"  pending_update_count: {result.get('pending_update_count')}")
    print(f"  last_error_date: {result.get('last_error_date')}")
    print(f"  last_error_message: {result.get('last_error_message')}")
    print(f"  max_connections: {result.get('max_connections')}")


def _resolve_webhook_url(base_url: str | None, *, route: str = "legacy") -> str:
    if not base_url:
        raise SystemExit("Provide --base-url or set PUBLIC_BASE_URL in .env before registering the Telegram webhook.")

    parsed = urlparse(base_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise SystemExit("Telegram webhooks require a public HTTPS base URL, for example https://api.example.com")

    suffix = {
        "legacy": "/webhook/telegram",
        "community": "/webhook/telegram/community",
        "clinical": "/webhook/telegram/clinical",
    }.get(route, "/webhook/telegram")
    return base_url.rstrip("/") + suffix


def _telegram_api_call(bot_token: str, method: str, payload: dict[str, object]) -> dict[str, object]:
    url = f"https://api.telegram.org/bot{bot_token}/{method}"
    with httpx.Client(timeout=20.0) as client:
        response = client.post(url, json=payload)
        response.raise_for_status()
    body = response.json()
    if not body.get("ok"):
        raise SystemExit(f"Telegram API call failed: {body}")
    result = body.get("result")
    if isinstance(result, dict):
        return result
    return {"description": str(result)}


if __name__ == "__main__":
    main()
