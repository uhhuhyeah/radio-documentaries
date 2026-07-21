/**
 * Render a `script.md` to tagged MP3 segments via ElevenLabs (flow step 6).
 *
 * The plan (which slots render, filenames, prev/next-text stitching, cue sheet)
 * is pure and unit-tested; `renderEpisode` executes it — the only part that
 * needs the ElevenLabs key. Consecutive SPOKEN slots are stitched for prosody;
 * a SONG slot between them resets the chain (it plays clean, in full).
 *
 * Output: `<workdir>/audio/sXXeXX_NN_label.mp3` (ID3-tagged) + `<workdir>/rundown.json`
 * (the ordered cue sheet the publish step consumes).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import NodeID3 from "node-id3";

import { VOICES } from "./constants";
import { apiKeyFromEnv, ElevenLabsError, synthesize, ttsBody } from "./elevenlabs";
import * as sm from "./scriptmodel";

const TAG_ARTIST = "SUB/WAVE Documentaries";
const DEFAULT_MODEL = "eleven_flash_v2_5";

const pad2 = (n: number): string => String(n).padStart(2, "0");
const asNum = (v: unknown, field: string): number => {
  if (typeof v !== "number") throw new ElevenLabsError(`front matter '${field}' must be a number`);
  return v;
};

export interface CueEntry {
  index: number;
  kind: sm.SlotKind;
  label: string;
  file?: string; // SPOKEN
  song?: { title: string; artist?: string; album?: string }; // SONG
}

export interface RenderStep {
  index: number;
  label: string;
  text: string;
  filename: string;
  prevText?: string; // set only when the previous slot is an adjacent SPOKEN
  nextText?: string;
}

export interface Plan {
  season: number;
  episode: number;
  steps: RenderStep[];
  cue: CueEntry[];
}

/** Pure: turn a parsed episode into an ordered render plan + cue sheet. */
export function planEpisode(ep: sm.Episode): Plan {
  const season = asNum(ep.frontMatter.season, "season");
  const episode = asNum(ep.frontMatter.episode, "episode");

  const steps: RenderStep[] = [];
  const cue: CueEntry[] = [];
  for (let i = 0; i < ep.slots.length; i++) {
    const slot = ep.slots[i]!;
    if (slot.kind === "SONG") {
      cue.push({
        index: slot.index,
        kind: "SONG",
        label: slot.label,
        song: { title: slot.meta.title ?? "", artist: slot.meta.artist, album: slot.meta.album },
      });
      continue;
    }
    const prev = ep.slots[i - 1];
    const next = ep.slots[i + 1];
    const filename = sm.segmentFilename(season, episode, slot);
    steps.push({
      index: slot.index,
      label: slot.label,
      text: slot.body,
      filename,
      prevText: prev && prev.kind === "SPOKEN" ? prev.body : undefined,
      nextText: next && next.kind === "SPOKEN" ? next.body : undefined,
    });
    cue.push({ index: slot.index, kind: "SPOKEN", label: slot.label, file: filename });
  }
  return { season, episode, steps, cue };
}

export interface RenderResult {
  audioDir: string;
  cuePath: string;
  rendered: number;
  cue: CueEntry[];
}

export interface RenderOptions {
  apiKey?: string;
  audioDir?: string;
}

export async function renderEpisode(scriptPath: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const ep = sm.loadEpisode(scriptPath);
  const host = String(ep.frontMatter.host);
  const voice = VOICES[host];
  if (!voice) throw new ElevenLabsError(`unknown host '${host}' (expected ${Object.keys(VOICES).join(" | ")})`);
  const modelId = typeof ep.frontMatter.model === "string" ? ep.frontMatter.model : DEFAULT_MODEL;

  const plan = planEpisode(ep);
  const albumTag = `S${pad2(plan.season)}E${pad2(plan.episode)} — ${ep.frontMatter.album} (Making Of)`;
  const apiKey = opts.apiKey ?? apiKeyFromEnv();
  const audioDir = opts.audioDir ?? join(dirname(scriptPath), "audio");
  mkdirSync(audioDir, { recursive: true });

  let prevIndex = -99;
  let prevRequestIds: string[] = [];
  let rendered = 0;

  for (const step of plan.steps) {
    const adjacent = step.index === prevIndex + 1; // contiguous index ⟹ no song between
    const body = ttsBody(step.text, modelId, voice.speed, {
      previousText: step.prevText,
      nextText: step.nextText,
      previousRequestIds: adjacent ? prevRequestIds : [],
    });
    const { audio, requestId } = await synthesize(voice.voiceId, body, apiKey);

    const filePath = join(audioDir, step.filename);
    writeFileSync(filePath, audio);
    NodeID3.write(
      { title: step.label, artist: TAG_ARTIST, album: albumTag, trackNumber: String(step.index) },
      filePath,
    );

    prevRequestIds = requestId ? [requestId] : [];
    prevIndex = step.index;
    rendered++;
  }

  const cuePath = join(dirname(scriptPath), "rundown.json");
  writeFileSync(
    cuePath,
    JSON.stringify({ season: plan.season, episode: plan.episode, album: albumTag, audioDir, cue: plan.cue }, null, 2),
  );

  return { audioDir, cuePath, rendered, cue: plan.cue };
}
