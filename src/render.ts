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

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import NodeID3 from "node-id3";

import { config } from "./config";
import { apiKeyFromEnv, ElevenLabsError, synthesize, ttsBody } from "./elevenlabs";
import * as sm from "./scriptmodel";

const TAG_ARTIST = "SUB/WAVE Documentaries";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Normalize a spoken segment before it goes to ElevenLabs.
 *
 * Two jobs. First: strip markdown that would be read aloud (LLMs emit *emphasis*,
 * links, etc. even when told not to) — belt to the writer-prompt's suspenders.
 *
 * Second, and the reason the tail matters: ElevenLabs Flash v2.5 will sometimes
 * hallucinate a short burst of foreign-language speech at the END of a segment
 * when the text trails off on something non-terminal — a dangling em-dash, a
 * markdown hard-break, a stray `---` slot separator, or just no closing
 * punctuation. Observed twice in S01E01-punisher. So we scrub trailing markdown,
 * collapse hard-break whitespace, and guarantee the segment ends on terminal
 * punctuation, leaving the model nothing open-ended to "continue".
 */
export function sanitizeForTts(text: string): string {
  let out = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/[*`]/g, "") // * ** ` emphasis/code
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?;:)]|$)/g, "$1$2") // _emphasis_ -> emphasis
    .replace(/^\s{0,3}#{1,6}\s+/gm, ""); // stray headings

  // Drop horizontal-rule / slot-separator lines (---, ***, ___) the writer left in.
  out = out.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "");

  // Em/en dashes read as a hanging pause (and a trailing one is a prime tail-
  // hallucination trigger). The house style uses "..." for beats, not dashes,
  // so any dash here is an anomaly — fold it into a comma so prosody survives.
  out = out.replace(/\s*[—–]\s*/g, ", ");

  // Collapse space/tab runs (this is also what markdown hard-breaks look like),
  // then strip trailing whitespace per line and overall.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();

  // Guarantee a terminal ending. If the last non-space char isn't sentence-final
  // punctuation (allowing a closing quote/bracket), drop any dangling separator
  // punctuation and add a period — no open-ended tail for the model to run past.
  if (out && !/[.!?…]["'”’)\]]?$/.test(out)) {
    out = out.replace(/[\s,;:.\-]+$/, "");
    out += ".";
  }

  return out;
}
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

/**
 * Delete orphaned segment MP3s left in `audioDir` by a previous render.
 *
 * `renderEpisode` only ever *writes* the segments the current plan produces; it
 * never removes stale ones. When a script is restructured (slots reordered, a
 * label renamed, a segment split), the old filenames — keyed by playback index
 * and label — no longer match, so the previous run's files linger as orphans.
 * They would otherwise be scanned/staged alongside the real episode. This makes
 * `audioDir` authoritative for the full plan: any `.mp3` the plan does not
 * produce is removed.
 *
 * Keyed on the *full plan's* filenames (not just this run's rendered subset), so
 * a resumed `--skip-spoken` render keeps the segments an earlier run wrote.
 * Returns the basenames it deleted.
 */
export function reconcileAudioDir(audioDir: string, expected: Iterable<string>): string[] {
  const keep = new Set(expected);
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(audioDir);
  } catch {
    return removed; // dir doesn't exist yet — nothing to reconcile
  }
  for (const name of entries) {
    if (name.endsWith(".mp3") && !keep.has(name)) {
      unlinkSync(join(audioDir, name));
      removed.push(name);
    }
  }
  return removed;
}

export interface RenderResult {
  audioDir: string;
  cuePath: string;
  rendered: number;
  cue: CueEntry[];
  /** Orphaned segment files removed to reconcile the dir against the plan (full renders only). */
  removed: string[];
}

export interface RenderOptions {
  apiKey?: string;
  audioDir?: string;
  /** Render only the first N spoken segments (cheap sample). Omit for the full episode. */
  maxSpoken?: number;
  /** Skip the first N spoken segments (already rendered); still writes the full rundown. */
  skipSpoken?: number;
  /** Override the ElevenLabs model (else the front-matter model). For A/B comparison. */
  model?: string;
  /** Render only the spoken slot with this label (e.g. "part-1"). For sampling one segment. */
  onlyLabel?: string;
}

export async function renderEpisode(scriptPath: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const ep = sm.loadEpisode(scriptPath);
  const host = String(ep.frontMatter.host);
  const voice = config.voices[host];
  if (!voice) {
    throw new ElevenLabsError(`no voice configured for host '${host}' — add [voices.${host}] to settings.toml`);
  }
  const modelId =
    opts.model ?? (typeof ep.frontMatter.model === "string" ? ep.frontMatter.model : config.elevenlabs.model);

  const plan = planEpisode(ep);
  const albumTag = `S${pad2(plan.season)}E${pad2(plan.episode)} — ${ep.frontMatter.album} (Making Of)`;
  const apiKey = opts.apiKey ?? apiKeyFromEnv();
  const audioDir = opts.audioDir ?? join(dirname(scriptPath), "audio");
  mkdirSync(audioDir, { recursive: true });

  let steps = plan.steps;
  if (opts.skipSpoken) steps = steps.slice(opts.skipSpoken);
  if (opts.maxSpoken) steps = steps.slice(0, opts.maxSpoken);
  if (opts.onlyLabel) steps = steps.filter((s) => s.label === opts.onlyLabel);

  let prevIndex = -99;
  let prevRequestIds: string[] = [];
  let rendered = 0;

  for (const step of steps) {
    const adjacent = step.index === prevIndex + 1; // contiguous index ⟹ no song between
    const body = ttsBody(sanitizeForTts(step.text), modelId, voice.speed, {
      previousText: step.prevText ? sanitizeForTts(step.prevText) : undefined,
      nextText: step.nextText ? sanitizeForTts(step.nextText) : undefined,
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

  // Reconcile the audio dir against the full plan so a restructured script's old
  // segments don't linger and get staged. Only on a full render: a --max-spoken
  // sample renders a subset, and --only re-renders a single segment in place —
  // neither should delete the siblings it didn't touch.
  const removed =
    opts.maxSpoken || opts.onlyLabel ? [] : reconcileAudioDir(audioDir, plan.steps.map((s) => s.filename));

  // For a sample, the cue covers only the slots up to the last rendered segment.
  const lastIdx = steps.length ? steps[steps.length - 1]!.index : 0;
  const cue = opts.maxSpoken ? plan.cue.filter((c) => c.index <= lastIdx) : plan.cue;

  const cueName = opts.maxSpoken ? "rundown.sample.json" : "rundown.json";
  const cuePath = join(dirname(scriptPath), cueName);
  writeFileSync(
    cuePath,
    JSON.stringify({ season: plan.season, episode: plan.episode, album: albumTag, audioDir, cue }, null, 2),
  );

  return { audioDir, cuePath, rendered, cue, removed };
}
