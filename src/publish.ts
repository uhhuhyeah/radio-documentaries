/**
 * Publish an episode to Navidrome (flow step 7b): read the rundown cue sheet,
 * resolve every slot to a Subsonic song id, and create the playlist in order —
 * spoken segments (now scanned into the episode "album") interleaved with the
 * in-place reference tracks. Run AFTER the audio is on the NAS and rescanned.
 */

import { readFileSync } from "node:fs";

import { clientFromEnv, songsOfAlbum } from "./navidrome";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PublishResult {
  playlistName: string;
  count: number;
  playlistId?: string;
}

export async function publishEpisode(rundownPath: string, playlistName?: string): Promise<PublishResult> {
  const rundown: any = JSON.parse(readFileSync(rundownPath, "utf-8"));
  const client = clientFromEnv();

  // The spoken segments were scanned into their own "album" (the ID3 TALB tag).
  const epAlbum = await client.findAlbum(String(rundown.album));
  if (!epAlbum) {
    throw new Error(`episode album "${rundown.album}" not found in Navidrome — has the rescan finished?`);
  }
  const epSongs = songsOfAlbum(await client.getAlbum(epAlbum.id));
  const byTitle = new Map<string, string>();
  const byTrack = new Map<number, string>();
  for (const s of epSongs) {
    byTitle.set(String(s.title).toLowerCase(), s.id);
    if (s.track != null) byTrack.set(Number(s.track), s.id);
  }

  const orderedIds: string[] = [];
  for (const c of rundown.cue as any[]) {
    if (c.kind === "SPOKEN") {
      // Segment ID3: title = slot label, track = slot index.
      const id = byTitle.get(String(c.label).toLowerCase()) ?? byTrack.get(Number(c.index));
      if (!id) throw new Error(`segment '${c.label}' (index ${c.index}) not found in the scanned episode album`);
      orderedIds.push(id);
    } else {
      let song = await client.findSong(String(c.song?.title), c.song?.album, c.song?.artist);
      if (!song && c.song?.album) {
        // Fuzzy fallback: match within the source album by substring (handles mis-tagged
        // titles like Navidrome's "DVD Menu-Garden Song" vs the script's "Garden Song").
        const srcAlb = await client.findAlbum(String(c.song.album), c.song.artist);
        if (srcAlb) {
          const want = String(c.song.title).toLowerCase();
          song =
            songsOfAlbum(await client.getAlbum(srcAlb.id)).find((s) => {
              const have = String(s.title).toLowerCase();
              return have === want || have.includes(want) || want.includes(have);
            }) ?? null;
        }
      }
      if (!song) throw new Error(`reference track '${c.song?.title}' not found in Navidrome`);
      orderedIds.push(song.id);
    }
  }

  const name = playlistName ?? `SUB/WAVE Docs · ${rundown.album}`;
  // Republish is idempotent: drop any existing playlist of the same name first.
  for (const p of await client.getPlaylists()) {
    if (p?.name === name && p?.id) await client.deletePlaylist(String(p.id));
  }
  const pl = await client.createPlaylist(name, orderedIds);
  return { playlistName: name, count: orderedIds.length, playlistId: pl?.id };
}
