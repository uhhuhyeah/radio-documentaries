/**
 * Estimate ElevenLabs credit spend for an episode before rendering (flow 6b).
 * Bills on characters of the SPOKEN text only (SONG slots are Navidrome tracks).
 */

import { readFileSync } from "node:fs";

import { MODEL_CREDIT_RATE, WORDS_PER_MINUTE } from "./constants";
import * as sm from "./scriptmodel";

export interface Estimate {
  chars: number;
  words: number;
  spokenMinutes: number;
  creditsByModel: Record<string, number>;
  chosenModel?: string;
  chosenCredits?: number;
}

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export function estimateText(text: string): Estimate {
  const ep = sm.parse(text);
  const spoken = sm.spokenSlots(ep);
  const chars = spoken.reduce((n, s) => n + s.body.length, 0);
  const words = spoken.reduce((n, s) => n + wordCount(s.body), 0);

  const creditsByModel: Record<string, number> = {};
  for (const [model, rate] of Object.entries(MODEL_CREDIT_RATE)) {
    creditsByModel[model] = chars * rate;
  }

  const chosenRaw = ep.frontMatter.model;
  const chosenModel = typeof chosenRaw === "string" ? chosenRaw : undefined;
  const chosenCredits = chosenModel !== undefined ? creditsByModel[chosenModel] : undefined;

  return {
    chars,
    words,
    spokenMinutes: words / WORDS_PER_MINUTE,
    creditsByModel,
    chosenModel,
    chosenCredits,
  };
}

export function estimateFile(path: string): Estimate {
  return estimateText(readFileSync(path, "utf-8"));
}

/** Cap gate for the automated budget check. null = can't determine (unknown model). */
export function withinCap(e: Estimate, cap: number): boolean | null {
  if (e.chosenCredits === undefined) return null;
  return e.chosenCredits <= cap;
}
