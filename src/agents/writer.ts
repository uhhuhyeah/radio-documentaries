/**
 * Writer sub-agent — turns research notes + episode metadata into a `script.md`
 * that satisfies the format contract. Pure LLM (no tools, no web): it uses ONLY
 * the research it is given. The Producer lints the output before it is rendered.
 */

import { complete } from "../llm";
import { WRITER_SYSTEM } from "./system-prompts";

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
    `Write in ${input.hostName}'s voice. Reference tracks must be from this album.`,
    ``,
    `--- RESEARCH NOTES (your only source of facts) ---`,
    input.research,
  ].join("\n");

  return complete(WRITER_SYSTEM, user);
}
