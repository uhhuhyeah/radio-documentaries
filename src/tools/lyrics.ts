/**
 * Fetch verbatim song lyrics from LRCLIB (https://lrclib.net) — free, no API key.
 *
 * Used to ground the Researcher's notes with a "Track Lyrics" bank so the Writer
 * can quote real lyrics instead of hallucinating them. Parsing is a pure helper
 * (unit-tested); the fetch is the only network part.
 */

const UA = "radio-documentaries (SUB/WAVE homelab; +https://lrclib.net)";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function plainLyrics(json: any): string | null {
  if (!json || json.instrumental) return null;
  const l = json.plainLyrics;
  return typeof l === "string" && l.trim() ? l.trim() : null;
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Lrclib-Client": "radio-documentaries" },
      signal: AbortSignal.timeout(12000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Exact get, then a search fallback. Returns plain lyrics or null (no match / instrumental). */
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
