/**
 * Deterministic quality gate — the editorial complement to `lint` (src/lint.ts).
 *
 * Lint validates the script's *format* (front matter, slot shape, kebab labels).
 * QA catches *content* regressions the Writer can slip past a format check:
 * hallucinated lyrics, wrong runtime, a missing station ident, source tags that
 * would get voiced, and a lop-sided song spread. Pure (`qaText`) so it's unit
 * testable without I/O, plus a thin file wrapper.
 */

import { readFileSync } from "node:fs";

import { WORDS_PER_MINUTE } from "./constants";
import { type Finding, type Level } from "./lint";
import * as sm from "./scriptmodel";

export { type Finding, type Level };

// Length gate: how far off `target_minutes` before we care, and the house range.
const LENGTH_TOLERANCE = 0.2; // ±20% of target_minutes
const HOUSE_MIN_MINUTES = 20;
const HOUSE_MAX_MINUTES = 30;
// SONG slots carry no duration; songs are real library tracks. Estimate each at a
// typical single length so the runtime check reflects the whole episode, not just
// the spoken parts (which lint already sanity-checks on their own).
const SONG_MINUTES_EST = 4;

// A quoted span this long (in words) is treated as a lyric rather than dialogue.
const LYRIC_MIN_WORDS = 5;

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/**
 * Normalise for lyric matching: lowercase, unify smart quotes/apostrophes, drop
 * remaining punctuation, and collapse whitespace. Applied to both the quoted span
 * and the bank so trivial punctuation/curly-quote differences don't read as a
 * fabricated lyric. Deliberately lossy — this is a heuristic, tuned to under- not
 * over-report (a false "matches" is safer than crying wolf on real dialogue).
 */
export function normalizeLyric(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”„‟«»]/g, '"') // smart double quotes
    .replace(/[‘’‚‛`´]/g, "'") // smart single quotes / apostrophes
    .replace(/[^\w' ]+/g, " ") // strip remaining punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The verbatim lyric bank: the body of the research's `## Track Lyrics` section
 * (its `### <track>` sub-blocks included), up to the next top-level `## ` heading
 * or end of file. Empty string when the research carries no lyric bank.
 */
export function lyricBank(researchText: string): string {
  const lines = researchText.split("\n");
  const start = lines.findIndex((l) => /^##\s+Track Lyrics/.test(l));
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break; // next top-level section ends the bank
    out.push(lines[i]!);
  }
  return out.join("\n");
}

// Double-quoted spans, straight or curly. Content may hold apostrophes but no
// double-quote char (so adjacent quoted spans don't merge into one).
const QUOTED_SPAN = /["“]([^"“”]+)["”]/g;

// A voiced source tag: bracketed text starting with a letter, e.g. [Wikipedia],
// [Stereogum], [reliable]. Requiring a leading letter skips slot markers like [01].
const SOURCE_TAG = /\[[A-Za-z][^\]]*\]/g;

/** Pure quality gate over a parsed script + the research notes (for the lyric bank). */
export function qaText(scriptText: string, researchText: string): Finding[] {
  const out: Finding[] = [];
  const err = (msg: string): void => void out.push({ level: "ERROR", msg });
  const warn = (msg: string): void => void out.push({ level: "WARN", msg });

  const ep = sm.parse(scriptText);
  const fm = ep.frontMatter;
  const spoken = sm.spokenSlots(ep);
  const songs = sm.songSlots(ep);

  // 1. LYRIC FIDELITY. Quoted, lyric-like spans in spoken text must appear
  //    verbatim (after normalisation) in the Track Lyrics bank. A miss is a
  //    fabricated-lyric risk. Heuristic (some quoted spans are dialogue), so WARN.
  //    Skipped entirely when the research has no bank — there's nothing to check
  //    against and the real pipeline always appends one.
  const bank = normalizeLyric(lyricBank(researchText));
  if (bank) {
    const seen = new Set<string>();
    for (const s of spoken) {
      for (const m of s.body.matchAll(QUOTED_SPAN)) {
        const span = m[1]!.trim();
        if (wordCount(span) < LYRIC_MIN_WORDS) continue; // short quotes: likely dialogue
        const norm = normalizeLyric(span);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        if (!bank.includes(norm)) {
          warn(`possible fabricated lyric (not verbatim in the Track Lyrics bank): ${JSON.stringify(span)}`);
        }
      }
    }
  }

  // 2. LENGTH IN RANGE. Estimate the whole-episode runtime (spoken words at
  //    WORDS_PER_MINUTE + a nominal length per SONG) and flag only when it's both
  //    off `target_minutes` and outside the 20–30 min house range.
  const spokenMin = spoken.reduce((n, s) => n + wordCount(s.body), 0) / WORDS_PER_MINUTE;
  const totalMin = spokenMin + songs.length * SONG_MINUTES_EST;
  const inHouse = totalMin >= HOUSE_MIN_MINUTES && totalMin <= HOUSE_MAX_MINUTES;
  const target = fm.target_minutes;
  if (typeof target === "number") {
    const offTarget = totalMin < target * (1 - LENGTH_TOLERANCE) || totalMin > target * (1 + LENGTH_TOLERANCE);
    if (offTarget && !inHouse) {
      warn(
        `estimated runtime ~${Math.round(totalMin)} min is off target_minutes=${target} ` +
          `and outside the ${HOUSE_MIN_MINUTES}–${HOUSE_MAX_MINUTES} min house range`,
      );
    }
  } else if (!inHouse) {
    warn(`estimated runtime ~${Math.round(totalMin)} min is outside the ${HOUSE_MIN_MINUTES}–${HOUSE_MAX_MINUTES} min house range`);
  }

  // 3. STATION IDENT. The intro (first spoken slot) must name the station.
  const intro = spoken[0];
  if (intro && !intro.body.toLowerCase().includes("subwave")) {
    err(`intro slot (${intro.label}) is missing the "Subwave" station ident`);
  }

  // 4. NO SPOKEN SOURCE TAGS. Bracketed source tags must never be voiced.
  const tags = new Set<string>();
  for (const s of spoken) {
    for (const m of s.body.matchAll(SOURCE_TAG)) tags.add(m[0]);
  }
  for (const tag of tags) {
    err(`spoken source tag would be voiced: ${tag}`);
  }

  // 5. REFERENCE-TRACK COUNT + SPREAD.
  const declared = fm.reference_tracks;
  if (typeof declared === "number" && declared !== songs.length) {
    warn(`reference_tracks=${declared} but found ${songs.length} SONG slot(s)`);
  }
  // Spread heuristic (kept deliberately simple):
  //   (a) no two SONG slots back-to-back — a song should sit between spoken beats;
  //   (b) no more than half the songs bunched into one third of the running order.
  for (let i = 1; i < ep.slots.length; i++) {
    if (ep.slots[i]!.kind === "SONG" && ep.slots[i - 1]!.kind === "SONG") {
      warn(`SONG slots '${ep.slots[i - 1]!.label}' and '${ep.slots[i]!.label}' are adjacent with no spoken slot between them`);
    }
  }
  const n = ep.slots.length;
  if (songs.length >= 2 && n >= 3) {
    const thirds = [0, 0, 0];
    ep.slots.forEach((s, pos) => {
      if (s.kind === "SONG") thirds[Math.min(2, Math.floor((pos * 3) / n))]!++;
    });
    if (Math.max(...thirds) > songs.length / 2) {
      warn(`songs are bunched — more than half fall in one third of the running order (${thirds.join("/")})`);
    }
  }

  return out;
}

/** File wrapper for the CLI / Producer tool. */
export function qaFiles(scriptPath: string, researchPath: string): Finding[] {
  return qaText(readFileSync(scriptPath, "utf-8"), readFileSync(researchPath, "utf-8"));
}
