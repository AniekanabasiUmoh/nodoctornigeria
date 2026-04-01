from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(slots=True)
class TriageResult:
    disposition: str
    matched_terms: list[str]
    rationale: str


NORMALIZATION_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bpikin\s+dey\s+shake\b", re.I), "convulsion"),
    (re.compile(r"\b(body|child|baby)\s+(is\s+)?shaking\b", re.I), "convulsion"),
    (re.compile(r"\bshaking\s+all\s+over\b", re.I), "convulsion"),
    (re.compile(r"\b(convulshon|convulson|convulsing)\b", re.I), "convulsion"),
    (re.compile(r"\b(unconcious|unconcscious)\b", re.I), "unconscious"),
    (re.compile(r"\b(pass(?:ed)?\s*out|fainted)\b", re.I), "collapsed"),
    (re.compile(r"\b(no\s+dey\s+wake|no\s+wake|won'?t\s+respond|not\s+responding)\b", re.I), "not waking"),
    (re.compile(r"\b(no\s+fit\s+drink|unable\s+to\s+drink|refusing\s+feeds?|cannot\s+breastfeed)\b", re.I), "cannot drink"),
    (re.compile(r"\b(no\s+fit\s+breathe|gasping|not\s+breathing\s+well|difficulty\s+in\s+breathing)\b", re.I), "difficulty breathing"),
    (re.compile(r"\b(bleeding\s+well\s+well|bleeding\s+too\s+much)\b", re.I), "heavy bleeding"),
    (re.compile(r"\b(too\s+weak\s+to\s+walk|cannot\s+stand|very\s+drowsy|lethargic)\b", re.I), "too weak to stand"),
    (re.compile(r"\b(stomach\s+pain\s+severe|severe\s+stomach\s+pain)\b", re.I), "severe abdominal pain"),
    (re.compile(r"\b(blood\s+in\s+stool|bloody\s+stool)\b", re.I), "bloody diarrhoea"),
)


EMERGENCY_PATTERNS = {
    "convulsion": re.compile(r"\b(convulsion|convulsions|seizure|seizures|fit|fits)\b", re.I),
    "unconscious": re.compile(r"\b(unconscious|not\s+waking|won'?t\s+wake|coma|collapsed?|unresponsive)\b", re.I),
    "cannot_drink": re.compile(r"\b(cannot\s+drink|can'?t\s+drink|not\s+drinking|poor\s+feeding|unable\s+to\s+drink)\b", re.I),
    "respiratory_distress": re.compile(
        r"\b(cannot\s+breathe|can'?t\s+breathe|struggling\s+to\s+breathe|difficulty\s+breathing|respiratory\s+distress|gasping|blue\s+lips|turning\s+blue)\b",
        re.I,
    ),
    "severe_bleeding": re.compile(r"\b(bleeding\s+heavily|heavy\s+bleeding|bleeding\s+plenty|profuse\s+bleeding)\b", re.I),
}

UNCERTAIN_PATTERNS = {
    "persistent_vomiting": re.compile(r"\b(persistent\s+vomiting|vomiting\s+everything|cannot\s+keep\s+anything\s+down)\b", re.I),
    "severe_weakness": re.compile(r"\b(very\s+weak|extremely\s+weak|too\s+weak\s+to\s+stand)\b", re.I),
    "chest_pain": re.compile(r"\b(chest\s+pain|tightness\s+in\s+the\s+chest)\b", re.I),
    "severe_abdominal_pain": re.compile(r"\b(severe\s+abdominal\s+pain|severe\s+stomach\s+pain)\b", re.I),
    "bloody_diarrhoea": re.compile(r"\b(bloody\s+diarrhoea|bloody\s+diarrhea|blood\s+in\s+stool)\b", re.I),
}


def assess_triage(query: str) -> TriageResult:
    normalized_query = _normalize_for_triage(query)
    emergency_hits = [label for label, pattern in EMERGENCY_PATTERNS.items() if pattern.search(normalized_query)]
    if emergency_hits:
        return TriageResult(
            disposition="EMERGENCY_ESCALATE",
            matched_terms=emergency_hits,
            rationale="Emergency danger signs detected in the user query.",
        )

    uncertain_hits = [label for label, pattern in UNCERTAIN_PATTERNS.items() if pattern.search(normalized_query)]
    if uncertain_hits:
        return TriageResult(
            disposition="UNCERTAIN_ESCALATE",
            matched_terms=uncertain_hits,
            rationale="Potential red-flag symptoms detected; safest path is escalation.",
        )

    return TriageResult(
        disposition="NON_EMERGENCY_CONTINUE",
        matched_terms=[],
        rationale="No emergency danger signs detected by the rules-based triage gate.",
    )


def _normalize_for_triage(query: str) -> str:
    normalized = query.strip().lower()
    for pattern, replacement in NORMALIZATION_RULES:
        normalized = pattern.sub(replacement, normalized)
    normalized = re.sub(r"[^a-z0-9\s']", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return _expand_triage_concepts(normalized)


def _expand_triage_concepts(normalized: str) -> str:
    tokens = set(normalized.split())
    additions: list[str] = []

    if tokens & {"shake", "shaking", "jerk", "jerking", "twitch", "twitching", "fits"}:
        additions.append("convulsion")

    if tokens & {"unresponsive", "coma", "collapsed", "collapse", "fainted"} or (
        ("wake" in tokens or "waking" in tokens or "responding" in tokens)
        and tokens & {"not", "no", "won't", "cant", "can't"}
    ):
        additions.append("unconscious")

    if tokens & {"drink", "drinking", "feed", "feeding", "breastfeed"} and tokens & {
        "cannot",
        "cant",
        "can't",
        "unable",
        "refusing",
        "poor",
        "not",
        "no",
    }:
        additions.append("cannot drink")

    if tokens & {"breathe", "breathing", "gasping", "blue"} and tokens & {
        "cannot",
        "cant",
        "can't",
        "difficulty",
        "struggling",
        "turning",
        "not",
        "no",
    }:
        additions.append("difficulty breathing")

    if tokens & {"bleeding", "bleed"} and tokens & {"heavy", "heavily", "much", "profuse", "plenty", "too"}:
        additions.append("heavy bleeding")

    if not additions:
        return normalized
    return f"{normalized} {' '.join(additions)}".strip()
