/**
 * Subsonic client for Navidrome — resolve album/track IDs, scan, build playlists.
 * Auth / envelope-checking / matching are pure functions (unit-tested without
 * network); the `Subsonic` class is the thin fetch wrapper around them.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_CLIENT = "subwave-docs";
export const API_VERSION = "1.16.1";

export class SubsonicError extends Error {}

export interface Album {
  id: string;
  name: string;
  artist?: string;
  songCount?: number;
  song?: Song | Song[];
  [k: string]: unknown;
}

export interface Song {
  id: string;
  title: string;
  album?: string;
  artist?: string;
  track?: number;
  [k: string]: unknown;
}

// --- pure helpers ------------------------------------------------------------

export function subsonicToken(password: string, salt: string): string {
  return createHash("md5").update(password + salt).digest("hex");
}

export function authParams(user: string, password: string, salt: string,
                           client: string = DEFAULT_CLIENT,
                           version: string = API_VERSION): Record<string, string> {
  return { u: user, t: subsonicToken(password, salt), s: salt, v: version, c: client, f: "json" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function checkResponse(payload: any): any {
  const resp = payload?.["subsonic-response"];
  if (resp === undefined) {
    throw new SubsonicError("malformed response: no 'subsonic-response' envelope");
  }
  if (resp.status === "failed") {
    const err = resp.error ?? {};
    throw new SubsonicError(`Subsonic error ${err.code}: ${err.message}`);
  }
  return resp;
}

export function asList<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

export function matchAlbum(albums: Album[], album: string, artist?: string): Album | null {
  for (const a of albums) {
    if ((a.name ?? "").toLowerCase() === album.toLowerCase()
        && (artist === undefined || (a.artist ?? "").toLowerCase() === artist.toLowerCase())) {
      return a;
    }
  }
  return null;
}

export function songsOfAlbum(albumObj: { song?: Song | Song[] }): Song[] {
  return asList(albumObj.song);
}

export function matchSong(songs: Song[], title: string,
                          album?: string, artist?: string): Song | null {
  for (const s of songs) {
    if ((s.title ?? "").toLowerCase() === title.toLowerCase()
        && (album === undefined || (s.album ?? "").toLowerCase() === album.toLowerCase())
        && (artist === undefined || (s.artist ?? "").toLowerCase() === artist.toLowerCase())) {
      return s;
    }
  }
  return null;
}

/** Minimal .env loader (avoids a dotenv dependency). Existing env wins. */
export function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = line.slice(i + 1).trim();
  }
}

// --- client ------------------------------------------------------------------

export interface SubsonicConfig {
  baseUrl: string;
  user: string;
  password: string;
  client?: string;
  version?: string;
  timeoutMs?: number;
}

export class Subsonic {
  constructor(private readonly cfg: SubsonicConfig) {}

  private async request(method: string,
                        params: Record<string, string | string[]> = {}): Promise<any> {
    const salt = randomBytes(8).toString("hex");
    const auth = authParams(this.cfg.user, this.cfg.password, salt, this.cfg.client, this.cfg.version);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...auth, ...params })) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else qs.append(k, v);
    }
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/rest/${method}.view?${qs.toString()}`;
    let payload: unknown;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15000) });
      payload = await res.json();
    } catch (e) {
      throw new SubsonicError(`HTTP error calling ${method}: ${String(e)}`);
    }
    return checkResponse(payload);
  }

  // read
  ping(): Promise<any> {
    return this.request("ping");
  }

  async search3(query: string, albumCount = 20, songCount = 30, artistCount = 0): Promise<any> {
    const r = await this.request("search3", {
      query,
      albumCount: String(albumCount),
      songCount: String(songCount),
      artistCount: String(artistCount),
    });
    return r.searchResult3 ?? {};
  }

  async findAlbum(album: string, artist?: string): Promise<Album | null> {
    const res = await this.search3(album, 50);
    return matchAlbum(asList(res.album), album, artist);
  }

  async getAlbum(id: string): Promise<Album> {
    return (await this.request("getAlbum", { id })).album ?? {};
  }

  async findSong(title: string, album?: string, artist?: string): Promise<Song | null> {
    const res = await this.search3(title, 20, 50);
    return matchSong(asList(res.song), title, album, artist);
  }

  async scanStatus(): Promise<any> {
    return (await this.request("getScanStatus")).scanStatus ?? {};
  }

  async getPlaylists(): Promise<any[]> {
    return asList((await this.request("getPlaylists")).playlists?.playlist);
  }

  // write (used only by the prompted playlist-build step)
  async startScan(full = false): Promise<any> {
    return (await this.request("startScan", full ? { fullScan: "true" } : {})).scanStatus ?? {};
  }

  async createPlaylist(name: string, songIds: string[]): Promise<any> {
    // Navidrome preserves the submitted songId order.
    return (await this.request("createPlaylist", { name, songId: songIds })).playlist ?? {};
  }
}

export function clientFromEnv(dotenvPath?: string): Subsonic {
  if (dotenvPath) loadDotenv(dotenvPath);
  const baseUrl = process.env.NAVIDROME_URL;
  const user = process.env.NAVIDROME_USER;
  const password = process.env.NAVIDROME_PASS;
  if (!baseUrl || !user || !password) {
    throw new SubsonicError("NAVIDROME_URL / NAVIDROME_USER / NAVIDROME_PASS not set (see .env.example)");
  }
  return new Subsonic({ baseUrl, user, password });
}
