/**
 * Make-ability gate — validate an episode CAN be made well BEFORE the pipeline
 * spends any research/render effort.
 *
 * Three checks: the album resolves in Navidrome (hard — publish needs its
 * reference tracks), enough track lyrics resolve (soft — low lyrics mean a
 * thin/short episode), and the required API keys are present (hard). The
 * network-touching `gatherPreflight` is kept separate from the PURE
 * `classifyPreflight` classifier so the verdict logic is unit-tested without the
 * network (mirrors how src/tools/web.ts splits its pure parsing helpers out).
 */

import { gatherAlbumLyrics } from "./tools/lyrics";
import { clientFromEnv } from "./navidrome";

export const DEFAULT_LYRICS_THRESHOLD = 0.8;

/** Env keys every API-touching stage needs; absence is a hard fail. */
export const REQUIRED_ENV_KEYS = [
  "BRAVE_API_KEY",
  "OPENROUTER_API_KEY",
  "ELEVENLABS_API_KEY",
  "NAVIDROME_URL",
  "NAVIDROME_USER",
  "NAVIDROME_PASS",
];

export type CheckStatus = "pass" | "soft-fail" | "hard-fail";

export interface PreflightCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  hardFail: boolean;
  softFail: boolean;
  checks: PreflightCheck[];
}

/** Raw check outcomes fed to the pure classifier (network already resolved). */
export interface PreflightFacts {
  album: { found: boolean; songCount: number };
  lyrics: { withLyrics: number; total: number };
  missingEnv: string[];
}

// --- pure helpers ------------------------------------------------------------

/** Required env keys that are unset or blank. */
export function missingEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_ENV_KEYS.filter((k) => !(env[k] ?? "").trim());
}

/** Turn raw check outcomes into a pass/soft-fail/hard-fail verdict. Pure. */
export function classifyPreflight(
  facts: PreflightFacts,
  lyricsThreshold: number = DEFAULT_LYRICS_THRESHOLD,
): PreflightReport {
  const checks: PreflightCheck[] = [];

  // 1. Album in Navidrome — HARD fail if missing (publish needs the reference tracks).
  checks.push(
    facts.album.found
      ? { name: "album-in-navidrome", status: "pass", detail: `found (${facts.album.songCount} track(s))` }
      : {
          name: "album-in-navidrome",
          status: "hard-fail",
          detail: "not found in Navidrome — publish needs the album's reference tracks",
        },
  );

  // 2. Lyrics resolve — SOFT fail below the threshold (low lyrics ⇒ thin/short episode).
  const { withLyrics, total } = facts.lyrics;
  const fraction = total > 0 ? withLyrics / total : 0;
  const pct = Math.round(fraction * 100);
  const minPct = Math.round(lyricsThreshold * 100);
  checks.push(
    fraction >= lyricsThreshold
      ? { name: "lyrics-resolve", status: "pass", detail: `${withLyrics}/${total} tracks (${pct}%) ≥ ${minPct}%` }
      : {
          name: "lyrics-resolve",
          status: "soft-fail",
          detail: `${withLyrics}/${total} tracks (${pct}%) < ${minPct}% — thin/short episode risk`,
        },
  );

  // 3. Required env keys — HARD fail if any are missing.
  checks.push(
    facts.missingEnv.length === 0
      ? { name: "required-env", status: "pass", detail: "all required keys present" }
      : { name: "required-env", status: "hard-fail", detail: `missing: ${facts.missingEnv.join(", ")}` },
  );

  const hardFail = checks.some((c) => c.status === "hard-fail");
  const softFail = checks.some((c) => c.status === "soft-fail");
  return { ok: !hardFail && !softFail, hardFail, softFail, checks };
}

// --- network -----------------------------------------------------------------

/** Resolve the raw check outcomes (Navidrome + LRCLIB + env). Never throws. */
export async function gatherPreflight(album: string, artist: string): Promise<PreflightFacts> {
  const missingEnv = missingEnvKeys();

  let found = false;
  let songCount = 0;
  try {
    const a = await clientFromEnv().findAlbum(album, artist);
    if (a) {
      found = true;
      songCount = Number(a.songCount ?? 0);
    }
  } catch {
    // Leave found=false; the env check reports missing NAVIDROME_* keys if that's the cause.
  }

  let withLyrics = 0;
  let total = 0;
  try {
    const rows = await gatherAlbumLyrics(album, artist);
    total = rows.length;
    withLyrics = rows.filter((r) => r.lyrics).length;
  } catch {
    // Leave 0/0 — classified as a soft fail.
  }

  return { album: { found, songCount }, lyrics: { withLyrics, total }, missingEnv };
}

/** Gather + classify: the full make-ability gate for an episode. */
export async function runPreflight(
  album: string,
  artist: string,
  lyricsThreshold: number = DEFAULT_LYRICS_THRESHOLD,
): Promise<PreflightReport> {
  return classifyPreflight(await gatherPreflight(album, artist), lyricsThreshold);
}
