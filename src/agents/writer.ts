/**
 * Writer sub-agent — turns research notes + episode metadata into a `script.md`
 * that satisfies the format contract. Pure LLM (no tools, no web): it uses ONLY
 * the research it is given. The Producer lints the output before it is rendered.
 */

import { config } from "../config";
import { PERSONAS, WORDS_PER_MINUTE } from "../constants";
import { complete } from "../llm";
import * as sm from "../scriptmodel";
import { WRITER_SYSTEM } from "./system-prompts";

// Length is settled HERE, at generation — never via a revision (deepening a draft pads and invents;
// we watched factcheck go 2→14 that way). A fresh write that lands short is regenerated fresh (the
// track-by-track length is variable run to run); a revision is a single pass that preserves length.
// Fresh writes aim for the ~20-min target; a short draft is regenerated fresh (never lengthened via
// a revision — that pads and invents). The qa house floor (15) sits well below this, so the margin
// absorbs the small trim a factual revision causes.
const FRESH_TARGET_MINUTES = 20;
const MAX_FRESH_ATTEMPTS = 3; // 1 + up to 2 fresh regenerations to reach the target

function personaBlock(hostId: string, hostName: string): string {
  const p = PERSONAS[hostId];
  if (!p) return `Write in ${hostName}'s voice.`;
  const dial = (n: number, lo: string, hi: string): string => (n >= 7 ? hi : n <= 3 ? lo : "balanced");
  return [
    `HOST PERSONA — write the ENTIRE script IN CHARACTER as ${p.name}, not as a neutral narrator:`,
    `  ${p.soul}.`,
    `  Tagline: "${p.tagline}"`,
    `  Tone — humour: ${dial(p.humour, "dry/understated", "witty/playful")}; ` +
      `local colour: ${dial(p.localColour, "avoid", "lean in")}; warmth: ${dial(p.warmth, "cool", "warm/earnest")}.`,
    `  ${p.name}'s personality should colour every line — the phrasing, the asides, the humour — even while`,
    `  the facts stay strictly from the research. This is a documentary hosted BY ${p.name}.`,
  ].join("\n");
}

export interface WriterInput {
  album: string;
  artist: string;
  host: string; // persona id, e.g. p_jools
  hostName: string; // Cara | Jools
  season: number;
  episode: number;
  model?: string; // ElevenLabs model for the front matter
  targetMinutes?: number;
  referenceTracks?: number;
  research: string; // the Researcher's notes (the only source of facts)
  /**
   * Producer's targeted fixes from a review pass (lint/QA/factcheck findings). When set together
   * with `previousDraft`, the Writer REVISES that draft to address these notes rather than
   * regenerating from scratch — so the bounded rewrite loop converges instead of rolling the dice.
   */
  revisionNotes?: string;
  previousDraft?: string; // the prior script.md to revise; required for revise mode
}

/** Songs that have verbatim lyrics in the research's "Track Lyrics" section. */
function songsWithLyrics(research: string): string[] {
  const idx = research.indexOf("## Track Lyrics");
  if (idx === -1) return [];
  return [...research.slice(idx).matchAll(/^### (.+)$/gm)].map((m) => m[1]!.trim());
}

const SLOT_KIND = /^##\s+\[\d{2}\]\s+(SPOKEN|SONG)\s*·/;
// Full slot heading with its parts: ## [NN] KIND · label
const SLOT_HEADING_LINE = /^##\s+\[(\d{2})\]\s+(SPOKEN|SONG)\s*·\s*(.+?)\s*$/;
const MAX_SONG_SLOTS = 5; // script-format.md: 3–5 reference tracks
const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Which of `count` items to KEEP for an even spread down to `max` (identity when count ≤ max).
 * Keeps the first and last and samples evenly between. Pure.
 */
export function keepIndices(count: number, max: number): number[] {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const keep = new Set<number>();
  for (let j = 0; j < max; j++) keep.add(Math.round((j * (count - 1)) / (max - 1)));
  return [...keep].sort((a, b) => a - b);
}

/**
 * Cap SONG slots to `max`, keeping an even spread across the running order and renumbering every
 * slot so indices stay contiguous (lint requires 1..N). The Writer's song count is erratic — the
 * length-forcing prompt can over-produce (8 seen) — so enforce the 3–5 format rule deterministically
 * here rather than nag the prompt. Front matter and each kept block are preserved verbatim except the
 * [NN] index; dropped tracks are still discussed in the spoken beats, they just lose the full play.
 * Pure.
 */
export function capSongSlots(script: string, max = MAX_SONG_SLOTS): string {
  const lines = script.split("\n");
  const headLines: number[] = [];
  lines.forEach((l, i) => {
    if (SLOT_HEADING_LINE.test(l)) headLines.push(i);
  });
  if (headLines.length === 0) return script;

  const blocks = headLines.map((h, k) => {
    const end = k + 1 < headLines.length ? headLines[k + 1]! : lines.length;
    const m = lines[h]!.match(SLOT_HEADING_LINE)!;
    return { kind: m[2]!, label: m[3]!, body: lines.slice(h + 1, end) };
  });

  const songPos = blocks.map((b, i) => (b.kind === "SONG" ? i : -1)).filter((i) => i >= 0);
  if (songPos.length <= max) return script; // nothing to trim

  const keep = new Set(keepIndices(songPos.length, max).map((j) => songPos[j]!));
  const kept = blocks.filter((b, i) => b.kind !== "SONG" || keep.has(i));

  const out = lines.slice(0, headLines[0]!); // front matter + any preamble
  kept.forEach((b, i) => {
    out.push(`## [${pad2(i + 1)}] ${b.kind} · ${b.label}`);
    out.push(...b.body);
  });
  return out.join("\n");
}

/**
 * Strip markdown from SPOKEN bodies only — deterministically, so the writer's stray emphasis
 * doesn't leave lint warnings (the render sanitizer already strips it from the audio; this keeps
 * the SCRIPT clean too). Removes exactly what lint flags — `*`, backtick, and `[text](url)` links —
 * and nothing else: front matter, slot headings, and SONG metadata lines are left untouched. Pure.
 */
export function stripSpokenMarkdown(script: string): string {
  let inSpoken = false;
  return script
    .split("\n")
    .map((line) => {
      const m = line.match(SLOT_KIND);
      if (m) {
        inSpoken = m[1] === "SPOKEN";
        return line; // never touch the heading itself
      }
      if (!inSpoken) return line; // front matter + SONG bodies stay verbatim
      return line
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
        .replace(/\]\([^)]*\)/g, "") // any residual link tail
        .replace(/[*`]/g, ""); // * ** ` emphasis/code — the rest of what lint flags
    })
    .join("\n");
}

/**
 * Build the Writer's user message. Pure (no LLM/IO) so both modes are unit-testable.
 * Fresh mode: generate the full script from the notes. Revise mode (revisionNotes + previousDraft
 * both present): fix exactly the producer's notes in the prior draft, keeping what already works.
 */
export function buildWriterMessage(input: WriterInput): string {
  const withLyrics = songsWithLyrics(input.research);
  const lyricsGuide = withLyrics.length
    ? `You have VERBATIM lyrics for these tracks: ${withLyrics.join(", ")}. Choose your SONG slots ` +
      `from these so you can quote accurately, and quote each song ONLY its own lyrics (never ` +
      `attribute one song's words to another). For any other song, describe it — do NOT quote lyrics.`
    : `No track lyrics are in the research — do NOT quote any song lyrics; describe the songs instead.`;
  const targetMinutes = input.targetMinutes ?? 20;
  const head = [
    `Episode metadata (use these exact values in the front matter):`,
    `  season: ${input.season}`,
    `  episode: ${input.episode}`,
    `  album: ${JSON.stringify(input.album)}`,
    `  artist: ${JSON.stringify(input.artist)}`,
    `  host: ${input.host}`,
    `  host_name: ${JSON.stringify(input.hostName)}`,
    `  model: ${input.model ?? config.elevenlabs.model}`,
    `  target_minutes: ${targetMinutes}`,
    `  reference_tracks: ${input.referenceTracks ?? 4}`,
    ``,
    personaBlock(input.host, input.hostName),
    ``,
    `Interleave 3–5 songs from this album as SONG slots, SPREAD THROUGHOUT (radio-show style:`,
    `spoken → song → spoken → song …), each with a natural hand-off in the surrounding spoken parts.`,
    `(The SONG slots are a subset of the tracks you cover — keep discussing other tracks' making-of in`,
    `the spoken beats even when they don't get their own song slot.)`,
    lyricsGuide,
    `Emit BARE --- front matter (never a \`\`\`yaml fence),`,
    `KEBAB-CASE slot labels, and NO markdown in spoken bodies.`,
  ];

  const revising = !!(input.revisionNotes && input.previousDraft);
  const tail = revising
    ? [
        `REVISION PASS — you already wrote the draft below and the producer reviewed it. Produce a`,
        `REVISED, COMPLETE script that fixes EXACTLY the notes and otherwise keeps what already works`,
        `(the structure, slot order, voice, and every part the notes don't mention). Do NOT regenerate`,
        `from scratch, and do NOT introduce any new claim that isn't in the research. Re-check every`,
        `quoted lyric against the Track Lyrics section — quotes must be word-for-word. Preserve the`,
        `script's length: do NOT trim below the ${targetMinutes}-minute house range while revising unless a`,
        `note explicitly asks you to cut — fix the flagged spans in place, keep the rest.`,
        ``,
        `PRODUCER'S REVISION NOTES — address each one:`,
        input.revisionNotes!.trim(),
        ``,
        `--- YOUR PREVIOUS DRAFT (revise THIS; output the full revised script) ---`,
        input.previousDraft!.trim(),
        ``,
        `--- RESEARCH NOTES (your only source of facts; re-verify quotes and claims against this) ---`,
        input.research,
      ]
    : [
        `Write the FULL ${targetMinutes}-minute script now — that length is a MINIMUM, not a ceiling.`,
        `STRUCTURE IT AS A TRACK-BY-TRACK MAKING-OF WALK: give most of the album's tracks their own spoken`,
        `beat digging into how THAT track was written, arranged, or produced. The research documents each`,
        `track, so there is real craft for every one — do not compress the album into a few broad parts.`,
        `Write AT LEAST 12 SPOKEN parts of ~250 words each (~3,000+ spoken words total, songs aside).`,
        `If you land shorter, you've left documented craft unused — go back to the notes and mine the`,
        `per-track detail you skipped. Never pad and never invent to reach length: the length comes from`,
        `covering more of the record in more depth, always from the notes.`,
        ``,
        `--- RESEARCH NOTES (your only source of facts) ---`,
        input.research,
      ];

  return [...head, ``, ...tail].join("\n");
}

/** Spoken minutes of a finished script (0 if it won't parse). Pure. */
export function spokenMinutes(script: string): number {
  try {
    const ep = sm.parse(script);
    const words = sm.spokenSlots(ep).reduce((n, s) => n + s.body.split(/\s+/).filter(Boolean).length, 0);
    return words / WORDS_PER_MINUTE;
  } catch {
    return 0;
  }
}

/**
 * Run the generator, retrying FRESH writes until the spoken runtime clears the house floor (keeping
 * the longest attempt), so length is settled at generation and never leaks into the revision loop.
 * A revise pass runs exactly once — it must preserve length, not grow it. Injectable `gen` for tests.
 */
export async function generateForLength(
  gen: () => Promise<string>,
  opts: { revising: boolean; minMinutes?: number; maxAttempts?: number },
): Promise<string> {
  const min = opts.minMinutes ?? FRESH_TARGET_MINUTES;
  const attempts = opts.revising ? 1 : (opts.maxAttempts ?? MAX_FRESH_ATTEMPTS);
  let best = "";
  let bestMin = -1;
  for (let i = 0; i < attempts; i++) {
    const script = await gen();
    const m = spokenMinutes(script);
    if (m > bestMin) {
      best = script;
      bestMin = m;
    }
    if (opts.revising || m >= min) break; // revise: one pass; fresh: stop once in range
  }
  return best;
}

export async function writeScript(input: WriterInput): Promise<string> {
  const revising = !!(input.revisionNotes && input.previousDraft);
  // One finished attempt: generate, strip markdown, cap songs. Fresh writes may run a few times to
  // clear the length floor; the reference_tracks reconcile happens once on the chosen script.
  const gen = async (): Promise<string> =>
    capSongSlots(stripSpokenMarkdown(await complete(WRITER_SYSTEM, buildWriterMessage(input))));
  const script = await generateForLength(gen, { revising });
  const nSongs = sm.songSlots(sm.parse(script)).length;
  return script.replace(/^reference_tracks:.*$/m, `reference_tracks: ${nSongs}`);
}
