# NSTG Frontline Care API Reference

## Base URL

```
https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api
```

---

## Endpoints

### Health Check

```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "runtime": "supabase-edge"
}
```

---

### Clinical Query

Route questions to clinician-facing pipeline (higher evidence threshold, more detailed reasoning).

```http
POST /clinical/query
Content-Type: application/json

{
  "query": "what should I give for pneumonia in a 3 year old?",
  "session_id": "clinic_A_patient_123",
  "top_k": 5
}
```

**Parameters:**
- `query` (string, required): Patient presentation or clinical question
- `session_id` (string, optional): Persist memory across turns. Format: `channel:user_id`
- `top_k` (number, optional): Evidence retrieval limit (1–10, default 5)

**Response:** `QueryResponse` (see below)

---

### Community Query

Route questions to community-friendly pipeline (plain language, practical actions, fewer assumptions about resources).

```http
POST /community/query
Content-Type: application/json

{
  "query": "pikin dey get fever since 2 days, no chop anything",
  "session_id": "whatsapp:1234567890",
  "top_k": 4
}
```

**Parameters:**
- Same as `/clinical/query`

**Response:** `QueryResponse` (see below)

---

## Response Schema

### QueryResponse

```json
{
  "interaction_id": "550e8400-e29b-41d4-a716-446655440000",
  "disposition": "ANSWER",
  "answer": "Based on 2 days of fever without eating, suspect malaria or typhoid. Key questions: Has the child had convulsions? Can the child drink? Can you check temperature? Once answered, you can start ACTs or refer based on danger signs.",
  "treat_here": true,
  "refer_urgency": null,
  "what_to_do_now": [
    "Ask: Can the child drink?",
    "Check: Temperature (if thermometer available)",
    "If fever >39°C AND convulsion history: Refer immediately",
    "If no danger signs: Start ACT (artemether-lumefantrine per weight)"
  ],
  "ask_or_check": "Can the child drink? And has there been any shaking/convulsion?",
  "immediate_actions": [],
  "danger_signs_detected": [],
  "triage": "NON_EMERGENCY_CONTINUE",
  "citations": [
    {
      "source_file": "NSTG_Malaria_2024.pdf",
      "condition": "Malaria",
      "section": "Assessment",
      "subsection": "Uncomplicated malaria",
      "page": 42
    }
  ],
  "dosage": {
    "medication": "Artemether-lumefantrine",
    "weight_kg": null,
    "formula": "Use NSTG table based on weight band",
    "dose_mg": null,
    "note": "it's okay if you don't have exact weight — use age-based approximation"
  },
  "warnings": [],
  "patient_snapshot": {
    "age_years": 3,
    "weight_kg": null,
    "symptoms": ["fever", "anorexia"],
    "onset_days": 2,
    "patient_age_group": "child_1_5y"
  }
}
```

**Field definitions:**

| Field | Type | Description |
|-------|------|-------------|
| `interaction_id` | string | Unique ID for this query-response pair (for feedback + audit) |
| `disposition` | enum | One of: `ANSWER`, `ASK_CLARIFY`, `EMERGENCY_ESCALATE`, `INSUFFICIENT_EVIDENCE` |
| `answer` | string | Plain-text clinical guidance (no markdown) |
| `treat_here` | boolean \| null | Can this be managed locally? `null` if unknown |
| `refer_urgency` | string \| null | If referring: `"immediate"`, `"soon"`, `"routine"`, or `null` |
| `what_to_do_now` | string[] | Ordered steps for the operator (2–5 items for ANSWER/EMERGENCY_ESCALATE) |
| `ask_or_check` | string \| null | If `disposition === "ASK_CLARIFY"`, one specific question |
| `immediate_actions` | string[] | For emergencies: first actions to take right now |
| `danger_signs_detected` | string[] | Red flags found in query (convulsion, inability to drink, etc.) |
| `triage` | string | (Deprecated, use `disposition`) Classification: `NON_EMERGENCY_CONTINUE`, `EMERGENCY_ESCALATE`, `UNCERTAIN_ESCALATE` |
| `citations` | Citation[] | Evidence sources (NSTG document + section + page) |
| `dosage` | DosageResult \| null | Drug dosing if applicable |
| `warnings` | string[] | Clinical warnings (e.g., "No Hb available — assess by pallor instead") |
| `patient_snapshot` | ExtractedPatientFacts \| null | Interpreted patient data (age, weight, symptoms, onset) |

---

### Disposition Guide

| Disposition | Meaning | Action |
|---|---|---|
| `ANSWER` | Safe to manage locally with NSTG guidance | Follow `what_to_do_now`. Reassess if patient deteriorates. |
| `ASK_CLARIFY` | Critical missing info needed to decide treat vs. refer | Ask the `ask_or_check` question. Re-submit with answer. |
| `EMERGENCY_ESCALATE` | Danger signs present; refer immediately | Call ambulance/refer. Do `immediate_actions` while waiting. |
| `INSUFFICIENT_EVIDENCE` | Query outside NSTG scope or too vague | Clarify context or consult supervisor. |

---

### Disposition Examples

**ANSWER** (fever, no danger signs):
```json
{
  "disposition": "ANSWER",
  "treat_here": true,
  "answer": "Likely malaria. Start ACTs. Follow dosing table. Reassess in 48h.",
  "what_to_do_now": [
    "Give artemether-lumefantrine per weight",
    "Encourage fluids",
    "Recheck in 48 hours"
  ]
}
```

**ASK_CLARIFY** (fever but critical info missing):
```json
{
  "disposition": "ASK_CLARIFY",
  "treat_here": null,
  "ask_or_check": "Can the child drink? And is there any history of convulsion?",
  "answer": "To decide if this is malaria you can treat here or if they need referral, I need to know: (1) Can they swallow and drink? (2) Any stiff body or shaking?"
}
```

**EMERGENCY_ESCALATE** (danger signs present):
```json
{
  "disposition": "EMERGENCY_ESCALATE",
  "treat_here": false,
  "refer_urgency": "immediate",
  "answer": "DANGER: Child cannot drink. This is severe malaria. Refer immediately to hospital.",
  "immediate_actions": [
    "Call ambulance now",
    "Keep child lying flat",
    "Do NOT attempt IV at home — refer for hospital care"
  ],
  "danger_signs_detected": ["cannot_drink", "severe_weakness"]
}
```

---

## Session Memory

Sessions are identified by `session_id` and persist across multiple turns.

**Session ID format:**
```
channel:user_id
```

**Examples:**
- `telegram:987654321` (Telegram user ID)
- `whatsapp:+234811234567` (WhatsApp phone number)
- `clinic_A:patient_123` (Custom clinic prefix)

**Memory includes:**
- Prior symptoms and patient facts
- Last differential diagnosis
- Active condition being investigated
- Prior clarification questions asked

**Clear session:** Send `/start` command (Telegram only). Programmatic clear via `clearSessionMemory()` in memory.ts.

---

## Error Handling

### HTTP Status Codes

| Code | Meaning |
|---|---|
| 200 | OK — response is valid |
| 202 | Accepted — async job created (voice jobs) |
| 400 | Bad request — missing required field |
| 403 | Forbidden — webhook secret mismatch |
| 404 | Not found — endpoint doesn't exist |
| 500 | Server error — check logs |

### Error Response

```json
{
  "detail": "descriptive error message"
}
```

---

## Rate Limiting

**Current:** No rate limiting in Edge Functions (rely on Supabase org limits).

**Recommended:** Implement at proxy layer:
- Max 100 req/min per session_id
- Max 1000 req/min per source IP

---

## Caching & Performance

**Retrieval:** NSTG evidence chunks cached in Supabase Vector Store (pgvector). No expiry — updates require manual re-indexing.

**LLM calls:** No caching. Each query invokes Groq `llama-3.3-70b-versatile`.

**Session memory:** Cached in `session_memory` table. Invalidated on `/start` (Telegram).

---

## Examples

### Example 1: Malaria with fast breathing

**Request:**
```json
{
  "query": "5 year old with fever 38.5C and breathing 50/min",
  "session_id": "clinic_B:child_456"
}
```

**Response:**
```json
{
  "disposition": "EMERGENCY_ESCALATE",
  "treat_here": false,
  "refer_urgency": "immediate",
  "answer": "DANGER: Fast breathing + fever suggests severe pneumonia or malaria. Refer immediately.",
  "immediate_actions": [
    "Do not delay — call ambulance now",
    "Keep child calm and upright",
    "Give oxygen if available"
  ],
  "danger_signs_detected": ["tachypnea", "fever", "possible_severe_pneumonia"]
}
```

---

### Example 2: Dehydration assessment (multi-turn)

**Turn 1 - Request:**
```json
{
  "query": "3 day diarrhoea, loose stool",
  "session_id": "whatsapp:+234811111111"
}
```

**Turn 1 - Response:**
```json
{
  "disposition": "ASK_CLARIFY",
  "ask_or_check": "Look at the eyes: are they sunken (deep-set)? And: can the child drink or does vomit come back?",
  "answer": "To assess dehydration, I need to know about eye appearance and whether they can keep fluids down."
}
```

**Turn 2 - Request (same session_id):**
```json
{
  "query": "eyes not sunken, child drinking well",
  "session_id": "whatsapp:+234811111111"
}
```

**Turn 2 - Response:**
```json
{
  "disposition": "ANSWER",
  "treat_here": true,
  "answer": "Good news: No sign of dehydration. Mild diarrhoea. Use ORS (oral rehydration salts). Continue feeding.",
  "what_to_do_now": [
    "Give ORS after each loose stool (5–10 mL per kg per episode)",
    "Continue normal feeding",
    "Watch for warning signs: eyes sinking, unable to drink, lethargy"
  ]
}
```

**Memory persistence:** System remembers "loose stool × 3 days" from Turn 1, adds "normal eyes, drinking well" from Turn 2.

---

### Example 3: Dosage with weight

**Request:**
```json
{
  "query": "artemether-lumefantrine dose for 12 kg child malaria",
  "session_id": "clinic_C:123"
}
```

**Response:**
```json
{
  "disposition": "ANSWER",
  "treat_here": true,
  "answer": "For 12 kg child with uncomplicated malaria: Artemether-lumefantrine 120 mg base.",
  "dosage": {
    "medication": "Artemether-lumefantrine",
    "weight_kg": 12,
    "formula": "NSTG Table 2.1 (by weight band)",
    "dose_mg": 120,
    "note": "Give twice daily for 3 days. Take with food if possible."
  },
  "citations": [
    {
      "condition": "Malaria",
      "section": "Treatment > Uncomplicated malaria > Dosing",
      "page": 47
    }
  ]
}
```

---

## Feedback & Improvement

**Submit feedback:**
```http
POST /feedback
Content-Type: application/json

{
  "interaction_id": "550e8400-e29b-41d4-a716-446655440000",
  "rating": "up",
  "comment": "helpful answer, child responded well"
}
```

**Rating:** `"up"` or `"down"`

**Comment:** Optional free-text feedback (stored for review team)

---

## Webhook Details

### Telegram Webhook

**Setup:**
```bash
curl -X POST https://api.telegram.org/bot{TOKEN}/setWebhook \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/webhook/telegram",
    "secret_token": "nstg_tg_2f84d1b6c7e94a30b5c2f8e1d4a7693c"
  }'
```

**Inbound payload:** Standard Telegram Update object (message.text, from.id, etc.)

**Outbound:** Sends text response via Telegram `sendMessage` API.

---

### WhatsApp Webhook

**Verification (GET):**
```http
GET /webhook/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=CHALLENGE
```

Returns `CHALLENGE` if token matches `WHATSAPP_WEBHOOK_TOKEN`.

**Inbound payload:** Meta WhatsApp Business API message object.

**Outbound:** Sends text via Meta Graph API `messages` endpoint.

---

## Support

For bugs, feature requests, or integration help:
- Email: support@nstg-frontline.example
- GitHub Issues: [repo link]
