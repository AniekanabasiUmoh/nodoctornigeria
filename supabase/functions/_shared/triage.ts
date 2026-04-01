import type { TriageResult } from "./types.ts";

const normalizationRules: Array<[RegExp, string]> = [
  [/\bpikin\s+dey\s+shake\b/gi, "convulsion"],
  [/\b(body|child|baby)\s+(is\s+)?shaking\b/gi, "convulsion"],
  [/\bshaking\s+all\s+over\b/gi, "convulsion"],
  [/\b(convulshon|convulson|convulsing)\b/gi, "convulsion"],
  [/\b(unconcious|unconcscious)\b/gi, "unconscious"],
  [/\b(pass(?:ed)?\s*out|fainted)\b/gi, "collapsed"],
  [/\b(no\s+dey\s+wake|no\s+wake|won'?t\s+respond|not\s+responding)\b/gi, "not waking"],
  [/\b(no\s+fit\s+drink|unable\s+to\s+drink|refusing\s+feeds?|cannot\s+breastfeed)\b/gi, "cannot drink"],
  [/\b(no\s+fit\s+breathe|gasping|not\s+breathing\s+well|difficulty\s+in\s+breathing)\b/gi, "difficulty breathing"],
  [/\b(bleeding\s+well\s+well|bleeding\s+too\s+much)\b/gi, "heavy bleeding"],
  [/\b(too\s+weak\s+to\s+walk|cannot\s+stand|very\s+drowsy|lethargic)\b/gi, "too weak to stand"],
  [/\b(stomach\s+pain\s+severe|severe\s+stomach\s+pain)\b/gi, "severe abdominal pain"],
  [/\b(blood\s+in\s+stool|bloody\s+stool)\b/gi, "bloody diarrhoea"],
];

const emergencyPatterns: Record<string, RegExp> = {
  convulsion: /\b(convulsion|convulsions|seizure|seizures|fit|fits)\b/i,
  unconscious: /\b(unconscious|not\s+waking|won'?t\s+wake|coma|collapsed?|unresponsive)\b/i,
  cannot_drink: /\b(cannot\s+drink|can'?t\s+drink|not\s+drinking|poor\s+feeding|unable\s+to\s+drink|cannot\s+feed|unable\s+to\s+feed)\b/i,
  respiratory_distress:
    /\b(cannot\s+breathe|can'?t\s+breathe|struggling\s+to\s+breathe|difficulty\s+breathing|respiratory\s+distress|gasping|blue\s+lips|turning\s+blue|fast\s+breathing|breathing\s+fast|breath(?:ing)?\s+fast)\b/i,
  severe_bleeding: /\b(bleeding\s+heavily|heavy\s+bleeding|bleeding\s+plenty|profuse\s+bleeding)\b/i,
};

const uncertainPatterns: Record<string, RegExp> = {
  persistent_vomiting: /\b(persistent\s+vomiting|vomiting\s+everything|cannot\s+keep\s+anything\s+down)\b/i,
  severe_weakness: /\b(very\s+weak|extremely\s+weak|too\s+weak\s+to\s+stand)\b/i,
  chest_pain: /\b(chest\s+pain|tightness\s+in\s+the\s+chest)\b/i,
  severe_abdominal_pain: /\b(severe\s+abdominal\s+pain|severe\s+stomach\s+pain)\b/i,
  bloody_diarrhoea: /\b(bloody\s+diarrhoea|bloody\s+diarrhea|blood\s+in\s+stool)\b/i,
};

export function assessTriage(query: string): TriageResult {
  const normalizedQuery = normalizeForTriage(query);
  const emergencyHits = Object.entries(emergencyPatterns)
    .filter(([label, pattern]) => pattern.test(normalizedQuery) && !isNegatedDangerSign(normalizedQuery, label) && !isContextualFalsePositive(normalizedQuery, label))
    .map(([label]) => label);
  if (emergencyHits.length > 0) {
    return {
      disposition: "EMERGENCY_ESCALATE",
      matched_terms: emergencyHits,
      rationale: "Emergency danger signs detected in the user query.",
    };
  }

  const uncertainHits = Object.entries(uncertainPatterns)
    .filter(([label, pattern]) => pattern.test(normalizedQuery) && !isNegatedUncertainPattern(normalizedQuery, label))
    .map(([label]) => label);
  if (uncertainHits.length > 0) {
    return {
      disposition: "UNCERTAIN_ESCALATE",
      matched_terms: uncertainHits,
      rationale: "Potential red-flag symptoms detected; safest path is escalation.",
    };
  }

  return {
    disposition: "NON_EMERGENCY_CONTINUE",
    matched_terms: [],
    rationale: "No emergency danger signs detected by the rules-based triage gate.",
  };
}

function normalizeForTriage(query: string): string {
  let normalized = query.trim().toLowerCase();
  for (const [pattern, replacement] of normalizationRules) {
    normalized = normalized.replace(pattern, replacement);
  }
  normalized = normalized.replace(/[^a-z0-9\s']/g, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  return expandTriageConcepts(normalized);
}

function expandTriageConcepts(normalized: string): string {
  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  const additions: string[] = [];

  if (["shake", "shaking", "jerk", "jerking", "twitch", "twitching", "fits"].some((token) => tokens.has(token))) {
    additions.push("convulsion");
  }

  if (
    ["unresponsive", "coma", "collapsed", "collapse", "fainted"].some((token) => tokens.has(token)) ||
    ((tokens.has("wake") || tokens.has("waking") || tokens.has("responding")) &&
      ["not", "no", "won't", "cant", "can't"].some((token) => tokens.has(token)))
  ) {
    additions.push("unconscious");
  }

  if (
    ["drink", "drinking", "feed", "feeding", "breastfeed"].some((token) => tokens.has(token)) &&
    ["cannot", "cant", "can't", "unable", "refusing", "poor", "not", "no"].some((token) => tokens.has(token)) &&
    !isContextualFalsePositive(normalized, "cannot_drink")
  ) {
    additions.push("cannot drink");
  }

  if (
    (
      ["breathe", "breathing", "gasping", "blue"].some((token) => tokens.has(token)) &&
      ["cannot", "cant", "can't", "difficulty", "struggling", "turning", "not", "no", "fast"].some((token) => tokens.has(token))
    ) ||
    (tokens.has("fast") && (tokens.has("breathing") || tokens.has("breathe")))
  ) {
    additions.push("difficulty breathing");
  }

  if (
    ["bleeding", "bleed"].some((token) => tokens.has(token)) &&
    ["heavy", "heavily", "much", "profuse", "plenty", "too"].some((token) => tokens.has(token))
  ) {
    additions.push("heavy bleeding");
  }

  if (!additions.length) {
    return normalized;
  }
  return `${normalized} ${additions.join(" ")}`.trim();
}

function isContextualFalsePositive(normalized: string, label: string): boolean {
  if (label === "cannot_drink") {
    return /\b(?:cannot|can't|cant)\s+drink\s+(?:cold\s+water|water|cold\s+drinks?|hot\s+drinks?|alcohol)\b/i.test(normalized);
  }
  return false;
}

function isNegatedDangerSign(normalized: string, label: string): boolean {
  const negationPatterns: Record<string, RegExp[]> = {
    convulsion: [/\b(?:no|not|without)\s+(?:convulsion|convulsions|seizure|seizures|fit|fits)\b/i],
    unconscious: [/\b(?:not|no)\s+(?:unconscious|unresponsive|collapsed?)\b/i, /\b(?:is|was)\s+conscious\b/i],
    cannot_drink: [/\b(?:can|still)\s+drink\b/i, /\b(?:able|still able)\s+to\s+drink\b/i],
    respiratory_distress: [
      /\b(?:no|not|without)\s+(?:breathing\s+problem|breathing\s+problems|difficulty\s+breathing|trouble\s+breathing|breathlessness|cough)\b/i,
      /\bbreathing\s+ok(?:ay)?\b/i,
    ],
    severe_bleeding: [/\b(?:no|not|without)\s+(?:heavy\s+bleeding|bleeding)\b/i],
  };
  return (negationPatterns[label] ?? []).some((pattern) => pattern.test(normalized));
}

function isNegatedUncertainPattern(normalized: string, label: string): boolean {
  const negationPatterns: Record<string, RegExp[]> = {
    persistent_vomiting: [/\b(?:no|not|without)\s+(?:vomiting|persistent\s+vomiting)\b/i],
    severe_weakness: [/\b(?:not|no)\s+weak(?:ness)?\b/i],
    chest_pain: [/\b(?:no|not|without)\s+chest\s+pain\b/i],
    severe_abdominal_pain: [/\b(?:no|not|without)\s+(?:severe\s+)?(?:abdominal|stomach)\s+pain\b/i],
    bloody_diarrhoea: [/\b(?:no|not|without)\s+blood\s+in\s+stool\b/i, /\b(?:no|not|without)\s+bloody\s+diarrh(?:oe|e)a\b/i],
  };
  return (negationPatterns[label] ?? []).some((pattern) => pattern.test(normalized));
}
