/**
 * Writer sub-agent — turns research notes + episode metadata into a `script.md`
 * that satisfies the format contract. Pure LLM (no tools, no web): it uses ONLY
 * the research it is given. The Producer lints the output before it is rendered.
 */

import { config } from "../config";
import { PERSONAS } from "../constants";
import { complete } from "../llm";
import * as sm from "../scriptmodel";
import { WRITER_SYSTEM } from "./system-prompts";

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
  const targetMinutes = input.targetMinutes ?? 25;
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
        `Write AT LEAST 12 SPOKEN parts of ~250–400 words each (~3,800+ spoken words total, songs aside).`,
        `If you land shorter, you've left documented craft unused — go back to the notes and mine the`,
        `per-track detail you skipped. Never pad and never invent to reach length: the length comes from`,
        `covering more of the record in more depth, always from the notes.`,
        ``,
        `--- RESEARCH NOTES (your only source of facts) ---`,
        input.research,
      ];

  return [...head, ``, ...tail].join("\n");
}

export async function writeScript(input: WriterInput): Promise<string> {
  const raw = await complete(WRITER_SYSTEM, buildWriterMessage(input));
  const script = stripSpokenMarkdown(raw); // deterministically clean spoken bodies (no lint noise)
  // Make the declared reference_tracks match the SONG slots actually written
  // (the writer may use fewer than requested; the front matter should describe reality).
  const nSongs = sm.songSlots(sm.parse(script)).length;
  return script.replace(/^reference_tracks:.*$/m, `reference_tracks: ${nSongs}`);
}
