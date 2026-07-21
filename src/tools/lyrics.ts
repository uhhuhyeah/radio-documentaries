/**
 * Fetch verbatim song lyrics from LRCLIB (https://lrclib.net) — free, no API key.
 *
 * Used to ground the Researcher's notes with a "Track Lyrics" bank so the Writer
 * can quote real lyrics instead of hallucinating them. Parsing is a pure helper
 * (unit-tested); the fetch is the only network part.
 */

import { clientFromEnv, songsOfAlbum } from "../navidrome";

const UA = "radio-documentaries (SUB/WAVE homelab; +https://lrclib.net)";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function plainLyrics(json: any): string | null {
  if (!json || json.instrumental) return null;
  const l = json.plainLyrics;
  return typeof l === "string" && l.trim() ? l.trim() : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** GET JSON, one short backoff retry on 429 (LRCLIB rate-limits bursts). Fails fast. */
async function getJson(url: string, tries = 2): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Lrclib-Client": "radio-documentaries" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429 && i < tries - 1) {
        await sleep(800);
        continue;
      }
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Exact get, then a search fallback (both back off on 429 via getJson). */
export async function fetchLyrics(artist: string, track: string, album?: string): Promise<string | null> {
  const q = new URLSearchParams({ artist_name: artist, track_name: track });
  if (album) q.set("album_name", album);
  const got = plainLyrics(await getJson(`https://lrclib.net/api/get?${q.toString()}`));
  if (got) return got;

  const s = new URLSearchParams({ track_name: track, artist_name: artist });
  const results = await getJson(`https://lrclib.net/api/search?${s.toString()}`);
  if (Array.isArray(results)) {
    for (const item of results) {
      const l = plainLyrics(item);
      if (l) return l;
    }
  }
  return null;
}

export interface TrackLyrics {
  track: string;
  lyrics: string | null;
}

/** Fetch verbatim lyrics for every track of an album (track list from Navidrome). Polite/spaced. */
export async function gatherAlbumLyrics(album: string, artist: string): Promise<TrackLyrics[]> {
  const client = clientFromEnv();
  const alb = await client.findAlbum(album, artist);
  if (!alb) return [];
  const tracks = songsOfAlbum(await client.getAlbum(alb.id));
  const out: TrackLyrics[] = [];
  for (const t of tracks) {
    const title = String(t.title ?? "").trim();
    if (!title) continue;
    out.push({ track: title, lyrics: await fetchLyrics(artist, title, album) });
    await sleep(600);
  }
  return out;
}
