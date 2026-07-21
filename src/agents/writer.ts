/**
 * Writer sub-agent — turns research notes + episode metadata into a `script.md`
 * that satisfies the format contract. Pure LLM (no tools, no web): it uses ONLY
 * the research it is given. The Producer lints the output before it is rendered.
 */

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
}

export async function writeScript(input: WriterInput): Promise<string> {
  const user = [
    `Episode metadata (use these exact values in the front matter):`,
    `  season: ${input.season}`,
    `  episode: ${input.episode}`,
    `  album: ${JSON.stringify(input.album)}`,
    `  artist: ${JSON.stringify(input.artist)}`,
    `  host: ${input.host}`,
    `  host_name: ${JSON.stringify(input.hostName)}`,
    `  model: ${input.model ?? "eleven_flash_v2_5"}`,
    `  target_minutes: ${input.targetMinutes ?? 25}`,
    `  reference_tracks: ${input.referenceTracks ?? 2}`,
    ``,
    personaBlock(input.host, input.hostName),
    ``,
    `Reference tracks must be from this album. Emit BARE --- front matter (never a \`\`\`yaml fence),`,
    `KEBAB-CASE slot labels, and NO markdown in spoken bodies.`,
    `Write the FULL ${input.targetMinutes ?? 25}-minute script now: aim for ~4,000 spoken words total across`,
    `about 12–16 SPOKEN parts of ~250–350 words each (plus the reference songs). Be thorough and`,
    `expansive; do not stop short.`,
    ``,
    `--- RESEARCH NOTES (your only source of facts) ---`,
    input.research,
  ].join("\n");

  const script = await complete(WRITER_SYSTEM, user);
  // Make the declared reference_tracks match the SONG slots actually written
  // (the writer may use fewer than requested; the front matter should describe reality).
  const nSongs = sm.songSlots(sm.parse(script)).length;
  return script.replace(/^reference_tracks:.*$/m, `reference_tracks: ${nSongs}`);
}
