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
// `target_minutes` / the house range are SPOKEN targets (the Writer prompt frames
// 20–30 min as ~3,500–4,500 spoken words, and budget.ts bills spoken minutes only),
// so this check measures spoken time and ignores SONG slots (real library tracks).
const LENGTH_TOLERANCE = 0.2; // ±20% of target_minutes
const HOUSE_MIN_MINUTES = 20;
const HOUSE_MAX_MINUTES = 30;

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
    .replace(/[‘’‚‛`´]/g, "'") // smart single quotes / apostrophes -> '
    .replace(/'/g, "") // DROP apostrophes: lover's->lovers, we're->were, fuckin'->fuckin
    .replace(/[^\w ]+/g, " ") // strip all remaining punctuation (smart double quotes, hyphens, /, …)
    .replace(/\b(?:[a-z] )+[a-z]\b/g, (m) => m.replace(/ /g, "")) // collapse spelled-out runs: l o v e -> love
    .replace(/\s+/g, " ")
    .trim();
}

// Lyric-match tiers. A quoted span's similarity to its best-matching window in the
// bank sorts it into: verbatim-enough (pass), a real lyric imperfectly quoted (fix),
// or no meaningful match at all (likely dialogue, possibly a fabrication). Tuned to
// let transcription noise (LRCLIB vs the script — "fuckin'"/"fucking", spelled-out
// letters, a stray article) pass, while still catching genuine misquotes.
const LYRIC_OK = 0.9; // >= this: treat as verbatim
const LYRIC_FIX = 0.55; // >= this (but < OK): a real lyric, not exact -> fix it

/**
 * Min edit distance between `needle` and its best-matching *substring* of `hay`
 * (row-0 seeded to 0 so a match may start anywhere). O(needle·hay); pure.
 */
function bestSubstringDistance(needle: string, hay: string): number {
  const n = needle.length;
  if (n === 0) return 0;
  const m = hay.length;
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1);
    cur[0] = i;
    const nc = needle.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1]! + (nc === hay.charCodeAt(j - 1) ? 0 : 1);
      const up = prev[j]! + 1;
      const left = cur[j - 1]! + 1;
      cur[j] = diag < up ? (diag < left ? diag : left) : up < left ? up : left;
    }
    prev = cur;
  }
  return Math.min(...prev);
}

/** Similarity in [0,1] of `needle` to its closest substring of `hay` (1 = verbatim). Pure. */
export function fuzzySubstringSimilarity(needle: string, hay: string): number {
  if (!needle) return 0;
  return Math.max(0, 1 - bestSubstringDistance(needle, hay) / needle.length);
}

/** Classify a quoted span against a NORMALISED lyric bank. Pure. */
export function lyricTier(span: string, normBank: string): "ok" | "fix" | "unknown" {
  const sim = fuzzySubstringSimilarity(normalizeLyric(span), normBank);
  return sim >= LYRIC_OK ? "ok" : sim >= LYRIC_FIX ? "fix" : "unknown";
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
        // Tiered instead of a binary substring test: a fuzzy match separates a real
        // lyric imperfectly quoted (fix it) from a span with no bank match (dialogue,
        // or a fabrication if it's meant to be sung) — and lets transcription noise pass.
        const tier = lyricTier(span, bank);
        if (tier === "fix") {
          warn(`non-verbatim lyric — close but not exact; quote it verbatim from the Track Lyrics bank: ${JSON.stringify(span)}`);
        } else if (tier === "unknown") {
          warn(
            `unverified quoted span — not found in the Track Lyrics bank; a fabricated lyric if it's sung, ` +
              `ignore if it's dialogue: ${JSON.stringify(span)}`,
          );
        }
      }
    }
  }

  // 2. LENGTH IN RANGE. Measure SPOKEN runtime (the thing `target_minutes` and the
  //    house range describe — SONG slots are library tracks, not spoken time) and
  //    flag only when it's both off `target_minutes` and outside the house range.
  const spokenMin = spoken.reduce((n, s) => n + wordCount(s.body), 0) / WORDS_PER_MINUTE;
  const inHouse = spokenMin >= HOUSE_MIN_MINUTES && spokenMin <= HOUSE_MAX_MINUTES;
  const target = fm.target_minutes;
  if (typeof target === "number") {
    const offTarget = spokenMin < target * (1 - LENGTH_TOLERANCE) || spokenMin > target * (1 + LENGTH_TOLERANCE);
    if (offTarget && !inHouse) {
      warn(
        `spoken runtime ~${Math.round(spokenMin)} min is off target_minutes=${target} ` +
          `and outside the ${HOUSE_MIN_MINUTES}–${HOUSE_MAX_MINUTES} min house range`,
      );
    }
  } else if (!inHouse) {
    warn(`spoken runtime ~${Math.round(spokenMin)} min is outside the ${HOUSE_MIN_MINUTES}–${HOUSE_MAX_MINUTES} min house range`);
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
