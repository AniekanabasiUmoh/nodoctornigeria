# Phase 3 Privacy and Retention Baseline

This document defines the current MVP baseline for privacy-aware logging, auditability, and retention in the NSTG Medical AI Assistant.

## Purpose

The system stores only the minimum structured data needed for:

- clinical safety review
- regression testing and debugging
- operational monitoring
- product decision support

It is not designed for unrestricted PHI collection or general-purpose patient record storage.

## What Is Stored

For medically relevant interactions, the current structured audit trace stores:

- route and channel
- raw user query text
- normalized query text
- top-k retrieval setting
- final response payload
- retrieved chunk metadata
- triage disposition
- deterministic dosage output, when present
- review-required flag
- operator review status placeholder
- timestamps

Feedback events store:

- interaction id
- thumbs up or thumbs down rating
- optional reviewer/user comment

Async job records store:

- job id
- channel
- query
- top-k
- status
- attempt count
- error text
- final result

## What Is Not Stored by Default

The MVP does not intentionally store the following as a required audit artifact:

- full patient identity
- names, phone numbers, or addresses in dedicated identity columns
- raw audio files
- transcribed voice archives outside the normal query field
- images or documents
- exact facility-level identity metadata

If users place personal identifiers directly inside free-text queries, those identifiers may still appear in logs until explicit redaction is added.

## Redaction Baseline

Current baseline:

- structured audit traces avoid dedicated PHI identity fields
- analytics events should prefer aggregated or anonymized payloads
- operator review should focus on minimum necessary context

Next recommended hardening step:

- add a query-redaction pass for phone numbers, email addresses, and obvious direct identifiers before long-term persistence

## Access Policy

Access to raw audit interactions should be limited to:

- designated engineering maintainers
- approved clinical reviewers
- authorized operators involved in safety review

Aggregated analytics should be kept separate from full audit review wherever possible.

## Retention Baseline

Current recommended default windows:

- raw audit interactions: 90 days
- feedback events: 180 days
- async job rows: 30 days after completion
- aggregated analytics: longer retention is acceptable if identity is removed

These are policy defaults for the MVP baseline and should be confirmed with the project owner before production launch.

## Encryption and Transport

Baseline expectations:

- TLS for all public API and webhook traffic
- encrypted managed database storage through Supabase platform defaults
- service-role credentials must remain server-side only

## Review Queue Guidance

Interactions should be flagged for review when they involve:

- emergency or uncertain triage dispositions
- insufficient evidence refusals
- clarification loops on potentially serious symptoms
- dosage warnings
- repeated low-quality feedback

## Open Items Before Production

- finalize exact retention windows with the project owner
- define approved reviewer roles
- add automatic identifier redaction
- document deletion workflow for audit records
- decide whether any channel-specific user identifiers should be hashed before storage
