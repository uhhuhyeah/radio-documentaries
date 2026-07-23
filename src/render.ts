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

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import NodeID3 from "node-id3";

import { config } from "./config";
import { assertCreditGuard } from "./credit";
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

export interface RenderManifest {
  version: 1;
  segments: Record<string, string>;
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

/**
 * Minimum byte size for an on-disk segment to be trusted as a complete render.
 *
 * A real ElevenLabs MP3 (44.1 kHz audio + ID3 tags) is comfortably larger than
 * this even for a one-sentence segment; a 0-byte stub or a file truncated when a
 * crash hit mid-write falls under it and is re-rendered rather than trusted. We
 * can't verify the audio stream without decoding, so this is the "sane min size"
 * floor — the cheapest guard that keeps resume from trusting a partial write.
 */
export const MIN_SEGMENT_BYTES = 1024;

export const RENDER_MANIFEST = "render-manifest.json";

export function segmentTextHash(text: string): string {
  return createHash("sha256").update(sanitizeForTts(text), "utf-8").digest("hex");
}

export function manifestForPlan(plan: Plan): RenderManifest {
  return {
    version: 1,
    segments: Object.fromEntries(plan.steps.map((s) => [s.filename, segmentTextHash(s.text)])),
  };
}

/**
 * Pure resume decision: given a plan and the segment files already present on
 * disk (basename → byte size), return the spoken steps that still need rendering.
 *
 * That is every MISSING segment, plus any present-but-truncated one (< the size
 * floor), while SKIPPING the complete in-plan files a prior partial run wrote —
 * so an interrupted render resumes instead of re-charging ElevenLabs for work it
 * already did. A fully-rendered episode yields an empty list (idempotent re-run).
 * `force` bypasses resume and returns the whole plan for a clean re-render.
 *
 * Kept separate from I/O (`presentSegments` reads the dir) so the decision is
 * unit-testable. This composes with the existing `reconcileAudioDir`: resume
 * decides what NOT to re-render among in-plan files; reconcile, keyed on the full
 * plan, removes only the NOT-in-plan orphans and never touches a kept segment.
 */
export function segmentsToRender(
  plan: Plan,
  present: Map<string, number>,
  opts: { force?: boolean; minBytes?: number; manifest?: RenderManifest | null } = {},
): RenderStep[] {
  if (opts.force) return plan.steps;
  const minBytes = opts.minBytes ?? MIN_SEGMENT_BYTES;
  const expected = opts.manifest ? manifestForPlan(plan).segments : undefined;
  return plan.steps.filter((s) => {
    const size = present.get(s.filename);
    if (size === undefined || size < minBytes) return true; // missing or truncated → render
    return expected ? opts.manifest?.segments[s.filename] !== expected[s.filename] : false;
  });
}

export function readRenderManifest(audioDir: string): RenderManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(audioDir, RENDER_MANIFEST), "utf-8")) as Partial<RenderManifest>;
    if (raw.version !== 1 || !raw.segments || typeof raw.segments !== "object") return null;
    return { version: 1, segments: Object.fromEntries(Object.entries(raw.segments).map(([k, v]) => [k, String(v)])) };
  } catch {
    return null;
  }
}

export function writeRenderManifest(audioDir: string, manifest: RenderManifest): void {
  writeFileSync(join(audioDir, RENDER_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/**
 * Read the segment MP3s already on disk into a basename → byte-size map — the
 * I/O half of the resume decision (`segmentsToRender` consumes it). A missing
 * dir yields an empty map (nothing to resume from).
 */
export function presentSegments(audioDir: string): Map<string, number> {
  const present = new Map<string, number>();
  let entries: string[];
  try {
    entries = readdirSync(audioDir);
  } catch {
    return present; // dir doesn't exist yet — nothing present
  }
  for (const name of entries) {
    if (!name.endsWith(".mp3")) continue;
    try {
      present.set(name, statSync(join(audioDir, name)).size);
    } catch {
      /* vanished between readdir and stat — treat as absent (render it) */
    }
  }
  return present;
}

export interface RenderResult {
  audioDir: string;
  cuePath: string;
  rendered: number;
  cue: CueEntry[];
  /** Orphaned segment files removed to reconcile the dir against the plan (full renders only). */
  removed: string[];
  /** In-plan segments kept from a prior partial render and NOT re-rendered (resume). */
  skipped: string[];
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
  /** Skip the credit hard-stop (balance + per-episode cap). Default OFF — the guard runs. */
  skipCreditGuard?: boolean;
  /** Per-episode credit cap for the guard. Default: config.budget.perEpisodeCap. */
  perEpisodeCap?: number;
  /** With the guard on, proceed on a FAILED balance query (cap-only). Default OFF (fail-closed). */
  allowUnknownBalance?: boolean;
  /** Force a clean full re-render: ignore complete segments a prior run left. Default OFF (resume ON). */
  force?: boolean;
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

  // Credit hard-stop — BEFORE any TTS call, so a render that can't finish (or blows
  // the per-episode cap) throws up front and no partial episode is ever written.
  // Estimates the FULL episode's credit need (conservative even for a sample).
  if (!opts.skipCreditGuard) {
    await assertCreditGuard(scriptPath, modelId, apiKey, opts.perEpisodeCap ?? config.budget.perEpisodeCap, {
      allowUnknownBalance: opts.allowUnknownBalance,
    });
  }

  const audioDir = opts.audioDir ?? join(dirname(scriptPath), "audio");
  mkdirSync(audioDir, { recursive: true });

  let steps = plan.steps;
  if (opts.skipSpoken) steps = steps.slice(opts.skipSpoken);
  if (opts.maxSpoken) steps = steps.slice(0, opts.maxSpoken);
  if (opts.onlyLabel) steps = steps.filter((s) => s.label === opts.onlyLabel);

  // Resume: on a NORMAL full render, skip re-rendering (and re-charging ElevenLabs
  // for) the plan's spoken segments a prior partial run already wrote completely —
  // rendering only the missing/truncated ones. The explicit selectors above are
  // manual overrides (a sample, one segment, a hand-picked skip), so resume stays
  // out of their way; `force` opts back into a clean full re-render.
  const skipped: string[] = [];
  const fullRender = !opts.skipSpoken && !opts.maxSpoken && !opts.onlyLabel;
  if (fullRender && !opts.force) {
    const present = presentSegments(audioDir);
    const toRender = segmentsToRender(plan, present, { manifest: readRenderManifest(audioDir) });
    const render = new Set(toRender);
    for (const s of plan.steps) if (!render.has(s)) skipped.push(s.filename);
    steps = toRender;
  }

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

  if (!opts.maxSpoken && !opts.onlyLabel) {
    writeRenderManifest(audioDir, manifestForPlan(plan));
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

  return { audioDir, cuePath, rendered, cue, removed, skipped };
}
