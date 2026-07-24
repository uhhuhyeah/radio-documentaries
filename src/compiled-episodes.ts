import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { config } from "./config";
import { read as readCatalog, rowsForSeason, setEpisodeCompiledSong, setSeasonPlaylist } from "./catalog";
import { asList, clientFromEnv, playlistUrlFromEnv, songsOfAlbum, waitForScan, type Song, type Subsonic } from "./navidrome";

const DEFAULT_COMMENT = "Compiled from SUB/WAVE making-of episode playlist";
const DEFAULT_GENRE = "Music Documentary";
const MIN_OUTPUT_BYTES = 1024 * 1024;

export interface CompilePlaylistOptions {
  playlistId: string;
  title?: string;
  album?: string;
  artist?: string;
  albumArtist?: string;
  season?: number;
  episode?: number;
  trackNumber?: number;
  outputFormat?: "m4a" | "mp3";
  includeChapters?: boolean;
  replace?: boolean;
  rescan?: boolean;
  wait?: boolean;
}

export interface CompilePlaylistResult {
  ok: boolean;
  playlistId: string;
  playlistName: string;
  outputPath: string;
  outputFormat: "m4a" | "mp3";
  durationSec: number;
  sourceCount: number;
  chapterCount: number;
  artist: string;
  albumArtist: string;
  album: string;
  title: string;
  trackNumber?: number;
  navidromeAlbumId?: string;
  navidromeSongId?: string;
  warnings: string[];
}

export interface CompileEpisodeTrackOptions {
  rundownPath: string;
  outputFormat?: "m4a" | "mp3";
  includeChapters?: boolean;
  replace?: boolean;
  rescan?: boolean;
  wait?: boolean;
}

export interface PublishCompiledSeasonPlaylistOptions {
  season: number;
  name?: string;
  album?: string;
  artist?: string;
}

export interface PublishCompiledSeasonPlaylistResult {
  ok: boolean;
  season: number;
  playlistName: string;
  playlistId: string;
  playlistUrl?: string;
  trackCount: number;
  tracks: { trackNumber: number; title: string; songId: string; durationSec?: number }[];
  warnings: string[];
}

interface SourceItem {
  id?: string;
  title: string;
  path: string;
  durationSec?: number;
}

interface Chapter {
  title: string;
  startMs: number;
  endMs: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function sanitizeFilename(name: string): string {
  return name
    .replace(/\//g, "-")
    .replace(/[:\\]/g, "-")
    .replace(/[?*"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function inferEpisodeFromTitle(title: string): { season?: number; episode?: number } {
  const m = title.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (!m) return {};
  return { season: Number(m[1]), episode: Number(m[2]) };
}

export function mapNavidromePath(
  path: string,
  musicRootNavidrome: string,
  musicRootPipeline: string,
): string {
  const pipelineRoot = normalize(musicRootPipeline);
  if (!isAbsolute(path)) return normalize(join(pipelineRoot, path));

  const navRoot = normalize(musicRootNavidrome);
  const normalized = normalize(path);
  const rel = relative(navRoot, normalized);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return normalize(join(pipelineRoot, rel));
  }
  return normalized;
}

export function assertPathUnder(path: string, roots: string[]): void {
  const resolved = resolve(path);
  for (const root of roots) {
    const rel = relative(resolve(root), resolved);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  }
  throw new Error(`resolved source path is outside allowed music roots: ${path}`);
}

export function outputPathForTrack(
  musicRoot: string,
  outputSubdir: string,
  title: string,
  trackNumber: number | undefined,
  outputFormat: "m4a" | "mp3",
): string {
  const prefix = trackNumber === undefined ? "" : `${pad2(trackNumber)} - `;
  return join(musicRoot, outputSubdir, `${prefix}${sanitizeFilename(title)}.${outputFormat}`);
}

export function concatManifestLine(path: string): string {
  return `file '${path.replace(/'/g, "'\\''")}'`;
}

export function ffmetadataText(
  metadata: {
    title: string;
    artist: string;
    albumArtist: string;
    album: string;
    trackNumber?: number;
    discNumber?: number;
    genre?: string;
    comment?: string;
  },
  chapters: Chapter[],
): string {
  const lines = [
    ";FFMETADATA1",
    `title=${escapeFfmetadata(metadata.title)}`,
    `artist=${escapeFfmetadata(metadata.artist)}`,
    `album_artist=${escapeFfmetadata(metadata.albumArtist)}`,
    `album=${escapeFfmetadata(metadata.album)}`,
    `genre=${escapeFfmetadata(metadata.genre ?? DEFAULT_GENRE)}`,
    `comment=${escapeFfmetadata(metadata.comment ?? DEFAULT_COMMENT)}`,
  ];
  if (metadata.trackNumber !== undefined) lines.push(`track=${metadata.trackNumber}`);
  if (metadata.discNumber !== undefined) lines.push(`disc=${metadata.discNumber}`);
  for (const ch of chapters) {
    lines.push(
      "",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${ch.startMs}`,
      `END=${ch.endMs}`,
      `title=${escapeFfmetadata(ch.title)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapeFfmetadata(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[=;#]/g, (m) => `\\${m}`);
}

export function chaptersFromSources(sources: { title: string; durationSec: number }[]): Chapter[] {
  let cumulative = 0;
  return sources.map((s) => {
    const startMs = cumulative;
    const durationMs = Math.round(s.durationSec * 1000);
    cumulative += durationMs;
    return { title: s.title, startMs, endMs: cumulative };
  });
}

function parseFfprobeDuration(stdout: string): number {
  const n = Number(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`ffprobe returned invalid duration: ${stdout.trim()}`);
  return n;
}

function ffprobeDuration(path: string): number {
  const stdout = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ], { encoding: "utf-8" });
  return parseFfprobeDuration(stdout);
}

function validateFfprobeReadable(path: string): void {
  execFileSync("ffprobe", ["-v", "error", "-show_streams", "-select_streams", "a:0", path], { stdio: "ignore" });
}

function runFfmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-y", ...args], { stdio: "inherit" });
}

async function resolvePlaylistSources(client: Subsonic, playlistId: string): Promise<{ playlistName: string; sources: SourceItem[] }> {
  const playlist = await client.getPlaylist(playlistId);
  const playlistName = String(playlist.name ?? playlistId);
  const entries = asList(playlist.entry);
  if (entries.length === 0) throw new Error(`playlist ${playlistId} has zero tracks`);

  const sources: SourceItem[] = [];
  for (const entry of entries) {
    const id = entry?.id === undefined ? undefined : String(entry.id);
    let rawPath = entry?.path === undefined ? undefined : String(entry.path);
    if (!rawPath && id) {
      const song = await client.getSong(id);
      rawPath = song.path === undefined ? undefined : String(song.path);
    }
    if (!rawPath) throw new Error(`playlist entry '${entry?.title ?? id ?? "?"}' has no source path`);
    const mapped = mapNavidromePath(rawPath, config.navidrome.musicRootNavidrome, config.navidrome.musicRootPipeline);
    assertPathUnder(mapped, [config.navidrome.musicRootPipeline]);
    if (!existsSync(mapped)) throw new Error(`source file not found: ${mapped}`);
    sources.push({
      id,
      title: String(entry?.title ?? entry?.name ?? mapped),
      path: mapped,
      durationSec: entry?.duration === undefined ? undefined : Number(entry.duration),
    });
  }
  return { playlistName, sources };
}

function compileSources(
  sources: SourceItem[],
  outputPath: string,
  metadata: {
    title: string;
    artist: string;
    albumArtist: string;
    album: string;
    trackNumber?: number;
    discNumber?: number;
  },
  outputFormat: "m4a" | "mp3",
  bitrate: string,
  includeChapters: boolean,
  replace: boolean,
): { durationSec: number; chapterCount: number } {
  if (existsSync(outputPath) && !replace) throw new Error(`output already exists: ${outputPath}`);
  mkdirSync(dirname(outputPath), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "subwave-compile-"));
  const tempAudio = join(scratch, `audio.${outputFormat}`);
  const tempFinal = join(dirname(outputPath), `.${Date.now()}-${sanitizeFilename(basename(outputPath))}.tmp.${outputFormat}`);
  try {
    const durations = sources.map((s) => ({ ...s, durationSec: s.durationSec && s.durationSec > 0 ? s.durationSec : ffprobeDuration(s.path) }));
    const expectedDuration = durations.reduce((sum, s) => sum + s.durationSec, 0);
    const manifestPath = join(scratch, "concat.txt");
    writeFileSync(manifestPath, `${sources.map((s) => concatManifestLine(s.path)).join("\n")}\n`, "utf-8");

    const codecArgs = outputFormat === "m4a" ? ["-c:a", "aac", "-b:a", bitrate] : ["-c:a", "libmp3lame", "-b:a", bitrate];
    runFfmpeg(["-f", "concat", "-safe", "0", "-i", manifestPath, "-vn", ...codecArgs, tempAudio]);

    const chapters = includeChapters ? chaptersFromSources(durations) : [];
    const metadataPath = join(scratch, "metadata.ffmeta");
    writeFileSync(metadataPath, ffmetadataText({ ...metadata, genre: DEFAULT_GENRE, comment: DEFAULT_COMMENT }, chapters), "utf-8");
    const muxArgs =
      outputFormat === "m4a"
        ? ["-i", tempAudio, "-i", metadataPath, "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", "-movflags", "use_metadata_tags", tempFinal]
        : ["-i", tempAudio, "-i", metadataPath, "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", tempFinal];
    runFfmpeg(muxArgs);

    const actualDuration = ffprobeDuration(tempFinal);
    const tolerance = Math.max(2, expectedDuration * 0.005);
    if (Math.abs(actualDuration - expectedDuration) > tolerance) {
      throw new Error(
        `compiled duration ${actualDuration.toFixed(2)}s differs from expected ${expectedDuration.toFixed(2)}s by more than ${tolerance.toFixed(2)}s`,
      );
    }
    if (statSync(tempFinal).size < MIN_OUTPUT_BYTES) throw new Error(`compiled output is implausibly small: ${tempFinal}`);
    validateFfprobeReadable(tempFinal);
    renameSync(tempFinal, outputPath);
    return { durationSec: actualDuration, chapterCount: chapters.length };
  } finally {
    if (existsSync(tempFinal)) rmSync(tempFinal, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function compilePlaylistToTrack(opts: CompilePlaylistOptions): Promise<CompilePlaylistResult> {
  const client = clientFromEnv();
  const defaults = config.compiledEpisodes;
  const { playlistName, sources } = await resolvePlaylistSources(client, opts.playlistId);
  const inferred = inferEpisodeFromTitle(playlistName);
  const season = opts.season ?? inferred.season;
  const episode = opts.episode ?? inferred.episode;
  const trackNumber = opts.trackNumber ?? episode;
  const outputFormat = opts.outputFormat ?? defaults.outputFormat;
  const includeChapters = opts.includeChapters ?? defaults.includeChapters;
  const artist = opts.artist ?? defaults.artist;
  const albumArtist = opts.albumArtist ?? artist;
  const album = opts.album ?? defaults.album;
  const title = opts.title ?? playlistName;
  const outputPath = outputPathForTrack(
    config.navidrome.musicRootPipeline,
    defaults.outputSubdir,
    title,
    trackNumber,
    outputFormat,
  );
  const compiled = compileSources(
    sources,
    outputPath,
    { title, artist, albumArtist, album, trackNumber, discNumber: season },
    outputFormat,
    defaults.bitrate,
    includeChapters,
    opts.replace ?? true,
  );

  let navidromeAlbumId: string | undefined;
  let navidromeSongId: string | undefined;
  const warnings: string[] = [];
  if (opts.rescan ?? true) {
    await client.startScan();
    if (opts.wait ?? true) await waitForScan(client);
    const ndAlbum = await client.findAlbum(album, artist);
    if (ndAlbum?.id) {
      navidromeAlbumId = ndAlbum.id;
      const songs = songsOfAlbum(await client.getAlbum(ndAlbum.id));
      const song = findCompiledSong(songs, title, trackNumber);
      if (song?.id) navidromeSongId = song.id;
    }
    if (!navidromeSongId) warnings.push("compiled track was written but not found in Navidrome after scan");
  }
  if (navidromeSongId && season !== undefined && episode !== undefined) {
    setEpisodeCompiledSong(season, episode, navidromeSongId);
  }
  if (season === undefined || episode === undefined) warnings.push("could not infer season/episode for catalog recording");

  return {
    ok: true,
    playlistId: opts.playlistId,
    playlistName,
    outputPath,
    outputFormat,
    durationSec: compiled.durationSec,
    sourceCount: sources.length,
    chapterCount: compiled.chapterCount,
    artist,
    albumArtist,
    album,
    title,
    trackNumber,
    navidromeAlbumId,
    navidromeSongId,
    warnings,
  };
}

export async function compileEpisodeTrack(opts: CompileEpisodeTrackOptions): Promise<CompilePlaylistResult> {
  const rundown = JSON.parse(readFileSync(opts.rundownPath, "utf-8")) as {
    season?: number;
    episode?: number;
    album?: string;
  };
  const season = Number(rundown.season);
  const episode = Number(rundown.episode);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) {
    throw new Error(`rundown lacks numeric season/episode: ${opts.rundownPath}`);
  }

  const row = rowsForSeason(readCatalog(), season).find((r) => r.ep === episode);
  if (!row) throw new Error(`S${pad2(season)}E${pad2(episode)} not found in seasons.md`);
  if (!row.playlistId || row.playlistId === "—") {
    throw new Error(`S${pad2(season)}E${pad2(episode)} has no Playlist ID recorded in seasons.md`);
  }

  return compilePlaylistToTrack({
    playlistId: row.playlistId,
    title: `SUB/WAVE Docs · ${rundown.album ?? `S${pad2(season)}E${pad2(episode)}`}`,
    season,
    episode,
    trackNumber: episode,
    outputFormat: opts.outputFormat,
    includeChapters: opts.includeChapters,
    replace: opts.replace,
    rescan: opts.rescan,
    wait: opts.wait,
  });
}

function findCompiledSong(songs: Song[], title: string, trackNumber: number | undefined): Song | null {
  const lower = title.toLowerCase();
  return (
    songs.find((s) => s.title.toLowerCase() === lower && (trackNumber === undefined || Number(s.track) === trackNumber)) ??
    songs.find((s) => s.title.toLowerCase() === lower) ??
    null
  );
}

export async function publishCompiledSeasonPlaylist(
  opts: PublishCompiledSeasonPlaylistOptions,
): Promise<PublishCompiledSeasonPlaylistResult> {
  const artist = opts.artist ?? config.compiledEpisodes.artist;
  const album = opts.album ?? config.compiledEpisodes.album;
  const text = readCatalog();
  const rows = rowsForSeason(text, opts.season)
    .filter((r) => r.compiledSongId && r.compiledSongId !== "—")
    .sort((a, b) => (a.ep ?? 0) - (b.ep ?? 0));
  if (rows.length === 0) throw new Error(`Season ${opts.season} has no compiled song IDs in seasons.md`);

  const client = clientFromEnv();
  const songIds = rows.map((r) => r.compiledSongId);
  const name = opts.name ?? `SUB/WAVE Docs · Season ${pad2(opts.season)} — Making Of Episodes`;
  for (const p of await client.getPlaylists()) {
    if (p?.name === name && p?.id) await client.deletePlaylist(String(p.id));
  }
  const playlist = await client.createPlaylist(name, songIds);
  const playlistId = String(playlist.id);
  const playlistUrl = playlistUrlFromEnv(playlistId);
  setSeasonPlaylist(opts.season, playlistId, playlistUrl);

  const ndAlbum = await client.findAlbum(album, artist);
  const albumSongs = ndAlbum?.id ? songsOfAlbum(await client.getAlbum(ndAlbum.id)) : [];
  const tracks = rows.map((r) => {
    const song = albumSongs.find((s) => s.id === r.compiledSongId);
    return {
      trackNumber: r.ep ?? 0,
      title: song?.title ?? `S${pad2(opts.season)}E${pad2(r.ep ?? 0)} — ${r.album}`,
      songId: r.compiledSongId,
      durationSec: song?.duration === undefined ? undefined : Number(song.duration),
    };
  });

  return { ok: true, season: opts.season, playlistName: name, playlistId, playlistUrl, trackCount: tracks.length, tracks, warnings: [] };
}
