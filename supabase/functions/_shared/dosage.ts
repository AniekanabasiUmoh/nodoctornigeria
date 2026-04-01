import type { ChunkRecord, DosageResult } from "./types.ts";

const weightRe = /(\d+(?:\.\d+)?)\s*kg\b/i;
const dosageRe = /(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*mg\s*\/\s*kg|(\d+(?:\.\d+)?)\s*mg\s*\/\s*kg/i;
const queryTokenRe = /[A-Za-z][A-Za-z0-9-]+/g;
const stopwords = new Set([
  "dose",
  "dosage",
  "for",
  "with",
  "child",
  "adult",
  "patient",
  "severe",
  "acute",
  "chronic",
  "treatment",
  "management",
  "query",
  "pulmonary",
  "oedema",
  "edema",
  "kg",
]);

export function calculateDosage(query: string, chunks: ChunkRecord[]): DosageResult | null {
  const weightKg = parseWeightKg(query);
  if (weightKg === null) {
    return null;
  }

  const matchingLines: Array<[string, string | null]> = [];
  const fallbackLines: Array<[string, string | null]> = [];

  for (const chunk of chunks) {
    for (const line of chunk.text.split(/\r?\n/)) {
      const loweredLine = line.toLowerCase();
      if (!loweredLine.includes("mg")) {
        continue;
      }
      const medication = guessMedicationName(query, line);
      if (medication) {
        matchingLines.push([line, medication]);
      }
      fallbackLines.push([line, medication]);
    }
  }

  const matchedFormula = matchDosageLine(matchingLines, weightKg);
  if (matchedFormula) {
    return matchedFormula;
  }

  if (matchingLines.length > 0) {
    return {
      medication: matchingLines[0][1],
      weight_kg: weightKg,
      formula: null,
      dose_mg: null,
      dose_range_mg: null,
      note: "The requested medication was found, but no explicit mg/kg dosing formula was present in the retrieved lines.",
    };
  }

  const fallbackFormula = matchDosageLine(fallbackLines, weightKg);
  if (fallbackFormula) {
    return fallbackFormula;
  }

  return {
    medication: null,
    weight_kg: weightKg,
    formula: null,
    dose_mg: null,
    dose_range_mg: null,
    note: "Weight was detected, but no explicit mg/kg dosing formula was found in the retrieved guideline chunks.",
  };
}

function parseWeightKg(query: string): number | null {
  const match = query.match(weightRe);
  return match ? Number(match[1]) : null;
}

function guessMedicationName(query: string, text: string): string | null {
  const queryWords = query.match(queryTokenRe) ?? [];
  const loweredText = text.toLowerCase();
  for (const word of queryWords) {
    if (word.length <= 3 || stopwords.has(word.toLowerCase())) {
      continue;
    }
    const tokenPattern = new RegExp(`\\b${escapeRegExp(word.toLowerCase())}\\b`);
    if (tokenPattern.test(loweredText)) {
      return word;
    }
  }
  return null;
}

function matchDosageLine(lines: Array<[string, string | null]>, weightKg: number): DosageResult | null {
  for (const [line, medication] of lines) {
    const match = line.match(dosageRe);
    if (!match) {
      continue;
    }
    if (match[1] && match[2]) {
      const low = roundDose(Number(match[1]) * weightKg);
      const high = roundDose(Number(match[2]) * weightKg);
      return {
        medication,
        weight_kg: weightKg,
        formula: `${match[1]}-${match[2]} mg/kg`,
        dose_mg: null,
        dose_range_mg: [low, high],
        note: "Calculated from retrieved mg/kg dosing text. Final clinical verification is still required.",
      };
    }

    const mgPerKg = Number(match[3]);
    return {
      medication,
      weight_kg: weightKg,
      formula: `${mgPerKg} mg/kg`,
      dose_mg: roundDose(mgPerKg * weightKg),
      dose_range_mg: null,
      note: "Calculated from retrieved mg/kg dosing text. Final clinical verification is still required.",
    };
  }
  return null;
}

function roundDose(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
