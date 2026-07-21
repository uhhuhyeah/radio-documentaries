/**
 * Validate a `script.md` against the format contract (`script-format.md`).
 * The deterministic gate on the Writer Agent's output. Errors block; warnings inform.
 */

import { readFileSync } from "node:fs";

import { MODEL_CREDIT_RATE, PERSONAS, REQUIRED_FRONT_MATTER, WORDS_PER_MINUTE } from "./constants";
import * as sm from "./scriptmodel";

export type Level = "ERROR" | "WARN";
export interface Finding {
  level: Level;
  msg: string;
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const pad2 = (n: number): string => String(n).padStart(2, "0");
const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export function lintText(text: string): Finding[] {
  const out: Finding[] = [];
  const err = (msg: string): void => void out.push({ level: "ERROR", msg });
  const warn = (msg: string): void => void out.push({ level: "WARN", msg });

  // 0. Malformed slot headings (typos that would silently drop a slot).
  for (const [lineno, line] of sm.findMalformedHeadings(text)) {
    err(`line ${lineno}: malformed slot heading: ${JSON.stringify(line)}`);
  }

  const ep = sm.parse(text);
  const fm = ep.frontMatter;

  // 1. Front matter completeness.
  for (const key of REQUIRED_FRONT_MATTER) {
    if (!(key in fm)) err(`front matter missing required key: ${key}`);
  }

  // 2. Host + host_name coherence.
  const host = fm.host;
  if (typeof host === "string" && !(host in PERSONAS)) {
    err(`host ${JSON.stringify(host)} is not a documentary persona ${JSON.stringify(Object.keys(PERSONAS))}`);
  } else if (typeof host === "string" && host in PERSONAS) {
    const expected = PERSONAS[host]!.name;
    if (fm.host_name !== undefined && fm.host_name !== expected) {
      warn(`host_name ${JSON.stringify(fm.host_name)} != persona name ${JSON.stringify(expected)}`);
    }
  }

  // 3. Model.
  const model = fm.model;
  if (typeof model === "string" && !(model in MODEL_CREDIT_RATE)) {
    warn(`model ${JSON.stringify(model)} not in known set ${JSON.stringify(Object.keys(MODEL_CREDIT_RATE))}`);
  }

  // 4. Slots exist.
  if (ep.slots.length === 0) {
    err("no slots found");
    return out;
  }

  // 5. Indices contiguous 1..N (spoken + song share one sequence).
  const indices = ep.slots.map((s) => s.index);
  const expected = Array.from({ length: indices.length }, (_, i) => i + 1);
  if (JSON.stringify(indices) !== JSON.stringify(expected)) {
    err(`slot indices must be contiguous ${JSON.stringify(expected)}, got ${JSON.stringify(indices)}`);
  }

  // 6. First slot should be SPOKEN.
  if (ep.slots[0]!.kind !== "SPOKEN") {
    warn("first slot is not SPOKEN (expected an intro)");
  }

  // 7. Per-slot checks.
  for (const s of ep.slots) {
    if (!KEBAB.test(s.label)) {
      warn(`slot ${pad2(s.index)}: label ${JSON.stringify(s.label)} is not kebab-case`);
    }
    if (s.kind === "SPOKEN") {
      if (s.body.trim() === "") err(`slot ${pad2(s.index)} (${s.label}): SPOKEN body is empty`);
      if (/[*`]|\]\([^)]*\)/.test(s.body)) {
        warn(`slot ${pad2(s.index)} (${s.label}): SPOKEN body has markdown (stripped at render; prefer clean prose)`);
      }
    } else {
      if (!("title" in s.meta)) err(`slot ${pad2(s.index)} (${s.label}): SONG missing 'title'`);
      for (const opt of ["artist", "album"]) {
        if (!(opt in s.meta)) warn(`slot ${pad2(s.index)} (${s.label}): SONG missing '${opt}'`);
      }
    }
  }

  // 8. reference_tracks count matches SONG slots, and is in 1..3.
  const nSongs = sm.songSlots(ep).length;
  const declared = fm.reference_tracks;
  if (typeof declared === "number" && declared !== nSongs) {
    err(`reference_tracks=${declared} but found ${nSongs} SONG slot(s)`);
  }
  if (!(nSongs >= 3 && nSongs <= 5)) {
    warn(`${nSongs} reference songs (script-format.md expects 3-5, interleaved for a radio-show feel)`);
  }

  // 9. Soft duration sanity: spoken minutes alone shouldn't blow the target.
  const words = sm.spokenSlots(ep).reduce((n, s) => n + wordCount(s.body), 0);
  const spokenMin = words / WORDS_PER_MINUTE;
  const target = fm.target_minutes;
  if (typeof target === "number") {
    if (spokenMin > target) {
      warn(`spoken content ~${Math.round(spokenMin)} min already exceeds target_minutes=${target} (songs add more)`);
    } else if (spokenMin < target * 0.4) {
      warn(`spoken content ~${Math.round(spokenMin)} min is thin for target_minutes=${target}`);
    }
  }

  return out;
}

export function lintFile(path: string): Finding[] {
  return lintText(readFileSync(path, "utf-8"));
}
