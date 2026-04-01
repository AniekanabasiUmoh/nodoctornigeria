from __future__ import annotations

import logging

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request

from .api_models import (
    AuditInteractionRecord,
    FeedbackRequest,
    FeedbackResponse,
    JobStatusResponse,
    QueryRequest,
    QueryResponse,
    ReviewQueueResponse,
    ReviewQueueSummary,
    ReviewStatusUpdateRequest,
    VoiceJobRequest,
    WebhookAckResponse,
)
from .channels import determine_telegram_route, parse_telegram_webhook, parse_twilio_webhook, strip_telegram_command
from .providers import get_telegram_clinical_messenger, get_telegram_messenger, get_twilio_messenger
from .settings import get_settings
from .service import get_audit_store, get_default_engine, get_job_store
from .web import render_home_page

app = FastAPI(title="NSTG Medical AI Assistant", version="0.2.0")
logger = logging.getLogger(__name__)


@app.get("/")
async def home():
    settings = get_settings()
    return render_home_page(settings.app_name)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/community/query", response_model=QueryResponse)
async def community_query(payload: QueryRequest) -> QueryResponse:
    engine = get_default_engine()
    result = engine.run_community(payload.query, top_k=payload.top_k)
    interaction_id = get_audit_store().log_interaction(
        route="/api/community/query",
        channel="community",
        query=payload.query,
        top_k=payload.top_k,
        response=result.response,
        trace=result.trace,
    )
    return result.response.model_copy(update={"interaction_id": interaction_id})


@app.post("/api/clinical/query", response_model=QueryResponse)
async def clinical_query(payload: QueryRequest) -> QueryResponse:
    engine = get_default_engine()
    result = engine.run_clinician(payload.query, top_k=payload.top_k)
    interaction_id = get_audit_store().log_interaction(
        route="/api/clinical/query",
        channel="clinical",
        query=payload.query,
        top_k=payload.top_k,
        response=result.response,
        trace=result.trace,
    )
    return result.response.model_copy(update={"interaction_id": interaction_id})


@app.post("/api/community/voice-jobs", response_model=JobStatusResponse, status_code=202)
async def create_community_voice_job(payload: VoiceJobRequest) -> JobStatusResponse:
    job_store = get_job_store()
    job = job_store.create_job(query=payload.query, top_k=payload.top_k, channel="community_voice_job")
    return job


@app.get("/api/jobs/{job_id}", response_model=JobStatusResponse)
async def get_job_status(job_id: str) -> JobStatusResponse:
    job_store = get_job_store()
    job = job_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.post("/api/jobs/{job_id}/process", response_model=JobStatusResponse)
async def process_job(job_id: str) -> JobStatusResponse:
    return _process_community_job(job_id)


@app.post("/api/feedback", response_model=FeedbackResponse)
async def submit_feedback(payload: FeedbackRequest) -> FeedbackResponse:
    try:
        return get_audit_store().log_feedback(payload)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/review/interactions", response_model=ReviewQueueResponse)
async def list_review_interactions(
    limit: int = Query(default=12, ge=1, le=50),
    review_required_only: bool = False,
) -> ReviewQueueResponse:
    items = get_audit_store().list_interactions(limit=limit, review_required_only=review_required_only)
    return ReviewQueueResponse(items=items, summary=_build_review_summary(items))


@app.post("/api/review/interactions/{interaction_id}/status", response_model=AuditInteractionRecord)
async def update_review_status(
    interaction_id: str,
    payload: ReviewStatusUpdateRequest,
) -> AuditInteractionRecord:
    try:
        return get_audit_store().update_review_status(interaction_id, payload.review_status)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/webhook/twilio/whatsapp", response_model=WebhookAckResponse)
async def twilio_whatsapp_webhook(request: Request, background_tasks: BackgroundTasks) -> WebhookAckResponse:
    message = parse_twilio_webhook(await request.body())
    if not message.text:
        return WebhookAckResponse(status="ignored", channel=message.channel)

    if message.user_id:
        _safe_send_channel_message(
            messenger=get_twilio_messenger(),
            to=message.user_id,
            text="Your message has been received. Processing has started.",
            channel="twilio_whatsapp",
        )

    job_store = get_job_store()
    job = job_store.create_job(query=message.text, top_k=4, channel="twilio_whatsapp")
    background_tasks.add_task(_process_community_job, job.job_id)
    return WebhookAckResponse(status="accepted", channel=message.channel, job_id=job.job_id)


@app.post("/webhook/telegram", response_model=WebhookAckResponse)
async def telegram_webhook(request: Request) -> WebhookAckResponse:
    return await _telegram_webhook_impl(request, route_override=None)


@app.post("/webhook/telegram/community", response_model=WebhookAckResponse)
async def telegram_community_webhook(request: Request) -> WebhookAckResponse:
    return await _telegram_webhook_impl(request, route_override="community")


@app.post("/webhook/telegram/clinical", response_model=WebhookAckResponse)
async def telegram_clinical_webhook(request: Request) -> WebhookAckResponse:
    return await _telegram_webhook_impl(request, route_override="clinical")


async def _telegram_webhook_impl(request: Request, *, route_override: str | None) -> WebhookAckResponse:
    settings = get_settings()
    secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
    if settings.telegram_webhook_secret and secret != settings.telegram_webhook_secret:
        raise HTTPException(status_code=403, detail="Invalid Telegram webhook secret.")

    payload = await request.json()
    message = parse_telegram_webhook(payload)
    query_text = strip_telegram_command(message.text)
    if not query_text:
        return WebhookAckResponse(status="ignored", channel=message.channel)

    engine = get_default_engine()
    route = route_override or determine_telegram_route(message.text)
    if route == "clinical":
        result = engine.run_clinician(query_text, top_k=5)
        interaction_id = get_audit_store().log_interaction(
            route="/webhook/telegram/clinical" if route_override else "/webhook/telegram",
            channel="telegram_clinical",
            query=query_text,
            top_k=5,
            response=result.response,
            trace=result.trace,
        )
    else:
        result = engine.run_community(query_text, top_k=4)
        interaction_id = get_audit_store().log_interaction(
            route="/webhook/telegram/community" if route_override else "/webhook/telegram",
            channel="telegram_community",
            query=query_text,
            top_k=4,
            response=result.response,
            trace=result.trace,
        )
    response = result.response

    if message.user_id:
        _safe_send_channel_message(
            messenger=get_telegram_clinical_messenger() if route == "clinical" else get_telegram_messenger(),
            to=message.user_id,
            text=response.answer[:1000],
            channel="telegram_clinical" if route == "clinical" else "telegram_community",
        )

    return WebhookAckResponse(
        status="accepted",
        channel=message.channel,
        preview=response.model_copy(update={"interaction_id": interaction_id}),
    )


def _process_community_job(job_id: str) -> JobStatusResponse:
    engine = get_default_engine()
    job_store = get_job_store()
    request = job_store.get_request(job_id)
    if request is None:
        raise HTTPException(status_code=404, detail="Job not found.")

    try:
        job_store.mark_running(job_id)
        result = engine.run_community(request.query, top_k=request.top_k)
        interaction_id = get_audit_store().log_interaction(
            route="/api/community/voice-jobs",
            channel=request.channel,
            query=request.query,
            top_k=request.top_k,
            response=result.response,
            trace=result.trace,
            job_id=job_id,
        )
        completed = result.response.model_copy(update={"interaction_id": interaction_id})
        job_store.mark_complete(job_id, completed)
    except Exception as exc:
        job_store.mark_failed(job_id, str(exc))
        raise

    job = job_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found after processing.")
    return job


def _safe_send_channel_message(*, messenger, to: str, text: str, channel: str) -> None:
    try:
        messenger.send_text(to=to, text=text)
    except Exception as exc:  # pragma: no cover - defensive network boundary
        logger.warning("Outbound %s send failed: %s", channel, exc)


def _build_review_summary(items: list[AuditInteractionRecord]) -> ReviewQueueSummary:
    emergency_dispositions = {"EMERGENCY_ESCALATE", "UNCERTAIN_ESCALATE"}
    return ReviewQueueSummary(
        total_items=len(items),
        review_required_items=sum(1 for item in items if item.review_required),
        reviewed_items=sum(1 for item in items if item.review_status),
        emergency_items=sum(1 for item in items if item.trace.final_disposition in emergency_dispositions),
        clinician_items=sum(1 for item in items if "clinical" in item.channel),
    )
