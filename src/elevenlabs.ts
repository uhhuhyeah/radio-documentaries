/**
 * ElevenLabs TTS client. Pure request-shaping is split from the network call so
 * it unit-tests without a key; `synthesize` is the only part that needs one.
 *
 * Blocked on a DEDICATED docs key (ELEVENLABS_API_KEY) — see producer-guide.md.
 * Built structurally so it's ready the moment that key exists.
 */

export const TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
export const OUTPUT_FORMAT = "mp3_44100_128";
export const SUBSCRIPTION_URL = "https://api.elevenlabs.io/v1/user/subscription";

export class ElevenLabsError extends Error {}

export interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

export interface TtsBody {
  text: string;
  model_id: string;
  voice_settings: VoiceSettings;
  previous_text?: string;
  next_text?: string;
  previous_request_ids?: string[];
}

export interface TtsOptions {
  previousText?: string;
  nextText?: string;
  previousRequestIds?: string[];
}

/** Defaults from producer-guide.md; speed is per-persona. */
export function voiceSettings(speed: number): VoiceSettings {
  return { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed };
}

export function ttsUrl(voiceId: string): string {
  return `${TTS_BASE}/${voiceId}?output_format=${OUTPUT_FORMAT}`;
}

export function ttsBody(text: string, modelId: string, speed: number, opts: TtsOptions = {}): TtsBody {
  const body: TtsBody = { text, model_id: modelId, voice_settings: voiceSettings(speed) };
  if (opts.previousText) body.previous_text = opts.previousText;
  if (opts.nextText) body.next_text = opts.nextText;
  if (opts.previousRequestIds && opts.previousRequestIds.length) {
    body.previous_request_ids = opts.previousRequestIds;
  }
  return body;
}

export function apiKeyFromEnv(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new ElevenLabsError("ELEVENLABS_API_KEY not set (see .env.example)");
  return k;
}

export interface SynthResult {
  audio: Buffer;
  requestId: string | null;
}

/**
 * The key's remaining credit balance, read before a render so we never START one
 * we can't finish (flow 6b — the credit hard-stop).
 *
 * ⚠️ ACCOUNT-LEVEL PROXY. The subscription endpoint reports usage for the whole
 * account (`character_count` / `character_limit`), NOT the per-key sub-quota. The
 * `quota_exceeded` we hit mid-render was against a PER-KEY limit (the
 * "Documentaries" key: "quota of 27000, you have 179 credits remaining"). If a
 * key has its own sub-quota below the account limit, this reads OPTIMISTICALLY —
 * i.e. it can report more remaining than the key can actually spend. It's the
 * best signal the public API exposes; for a single-key account it's exact. The
 * guard treats a FAILED read as fail-closed (see src/credit.ts), so a missing
 * signal never silently permits spend — but a per-key sub-limit it can't see
 * remains a known gap (tighten via [budget] per_episode_cap below the key quota).
 *
 * Units: `character_limit`/`character_count` are the same credit unit budget.ts
 * estimates in (multilingual = 1 credit/char, flash v2.5 ≈ 0.5), so
 * `remaining = limit − used` is directly comparable to an Estimate's credits.
 */
export interface CreditBalance {
  remaining: number;
  limit: number;
  used: number;
}

export async function fetchCreditBalance(apiKey: string): Promise<CreditBalance> {
  const res = await fetch(SUBSCRIPTION_URL, {
    method: "GET",
    headers: { "xi-api-key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ElevenLabsError(`subscription ${res.status} ${res.statusText}: ${detail.slice(0, 300)}`);
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const json: any = await res.json();
  const limit = Number(json?.character_limit);
  const used = Number(json?.character_count);
  if (!Number.isFinite(limit) || !Number.isFinite(used)) {
    throw new ElevenLabsError(`subscription response missing character_limit/character_count: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { remaining: limit - used, limit, used };
}

/** POST one segment; returns the MP3 bytes and the request-id (for stitching). */
export async function synthesize(voiceId: string, body: TtsBody, apiKey: string): Promise<SynthResult> {
  const res = await fetch(ttsUrl(voiceId), {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ElevenLabsError(`TTS ${res.status} ${res.statusText}: ${detail.slice(0, 300)}`);
  }
  return {
    audio: Buffer.from(await res.arrayBuffer()),
    requestId: res.headers.get("request-id"),
  };
}
