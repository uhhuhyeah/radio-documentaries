Add “Compiled Episode Track” Support to `subwave-pipeline` MCP

## Goal

Extend the `subwave-pipeline` MCP so published SUB/WAVE “Making Of” episode playlists in Navidrome can be compiled into **single long-form audio tracks**.

The target use case:

- Existing published episodes are represented in Navidrome as playlists containing many items, e.g.
  - `SUB/WAVE Docs · S01E01 — Punisher (Making Of)`
  - 15 tracks
  - ~40 minutes
- We want to create **one compiled audio file per episode**.
- Each compiled file should appear in Navidrome as a single track.
- Artist / album artist should be:
  - `SUB/WAVE Documentaries`
- Album should be:
  - `SUB/WAVE Docs`
- Track title should be the playlist/episode name, e.g.
  - `SUB/WAVE Docs · S01E01 — Punisher (Making Of)`
- Then we can build a new Navidrome playlist for the season containing only the compiled tracks, so SUB/WAVE Radio can play one track and get the whole episode.

Preferred library model:

```text
Artist: SUB/WAVE Documentaries
Album: SUB/WAVE Docs
Tracks:
  01. SUB/WAVE Docs · S01E01 — Punisher (Making Of)
  02. SUB/WAVE Docs · S01E02 — Melodrama (Making Of)
  03. SUB/WAVE Docs · S01E03 — Weathervanes (Making Of)
  ...
```

This is **Option A** from the prior design discussion.

---

# New Capabilities to Add

## 1. Compile an existing Navidrome playlist into one audio track

Add a new MCP tool such as:

```ts
compile_playlist_to_track({
  playlistId: string,
  title?: string,
  album?: string,
  artist?: string,
  albumArtist?: string,
  season?: number,
  episode?: number,
  trackNumber?: number,
  outputFormat?: "m4a" | "mp3",
  includeChapters?: boolean,
  replace?: boolean,
  rescan?: boolean,
  wait?: boolean
})
```

The `playlistId` is a required input. Do **not** hunt across Navidrome playlists by
name as the default behavior. The pipeline should record playlist IDs/URLs when
it creates them, and backfill can pass explicit IDs/URLs supplied by the operator.

Suggested defaults:

```json
{
  "album": "SUB/WAVE Docs",
  "artist": "SUB/WAVE Documentaries",
  "albumArtist": "SUB/WAVE Documentaries",
  "outputFormat": "m4a",
  "includeChapters": true,
  "replace": true,
  "rescan": true,
  "wait": true
}
```

The `title` should default to the playlist name fetched from Navidrome.

The `trackNumber` should default to the episode number if supplied, otherwise infer from the playlist name if possible.

Example:

```ts
compile_playlist_to_track({
  playlistId: "MJujkaoQDFwEdnHfmGRqVv",
  season: 1,
  episode: 1
})
```

Expected result:

```json
{
  "ok": true,
  "playlistId": "MJujkaoQDFwEdnHfmGRqVv",
  "playlistName": "SUB/WAVE Docs · S01E01 — Punisher (Making Of)",
  "outputPath": "/music/SUB-WAVE Documentaries/SUB-WAVE Docs/01 - SUB-WAVE Docs · S01E01 — Punisher (Making Of).m4a",
  "durationSec": 2400,
  "chapterCount": 15,
  "artist": "SUB/WAVE Documentaries",
  "albumArtist": "SUB/WAVE Documentaries",
  "album": "SUB/WAVE Docs",
  "title": "SUB/WAVE Docs · S01E01 — Punisher (Making Of)",
  "trackNumber": 1,
  "navidromeAlbumId": "...",
  "navidromeSongId": "..."
}
```

---

## 2. Compile from an episode `rundown.json`

Published episodes already produce a `rundown.json` cue sheet. Add a more pipeline-native tool such as:

```ts
compile_episode_track({
  rundownPath: string,
  outputFormat?: "m4a" | "mp3",
  includeChapters?: boolean,
  replace?: boolean,
  rescan?: boolean,
  wait?: boolean
})
```

This should:

1. Read `rundown.json`.
2. Derive:
   - season
   - episode
   - episode title / playlist name
   - ordered audio/reference track sequence
   - segment/chapter labels
   - durations if present
3. Resolve all source files.
4. Compile a single long-form track.
5. Tag it.
6. Stage it into the Navidrome Music library.
7. Trigger/wait for scan.
8. Return Navidrome song ID.

This should be the preferred tool for newly produced SUB/WAVE episodes because `rundown.json` is the source of truth for cue order.

If this path needs the already-published source playlist, read its ID from the
local `seasons.md` catalog row rather than rediscovering it in Navidrome.

---

## 3. Create or update a “compiled season” playlist

Add a tool such as:

```ts
publish_compiled_season_playlist({
  season: number,
  name?: string,
  album?: string,
  artist?: string
})
```

Suggested default playlist name:

```text
SUB/WAVE Docs · Season 01 — Making Of Episodes
```

Behavior:

1. Find all compiled tracks for:
   - artist: `SUB/WAVE Documentaries`
   - album: `SUB/WAVE Docs`
   - season: requested season
2. Order by track number.
3. Create or replace a Navidrome playlist containing only the compiled episode tracks.
4. Return playlist ID / URL / track list.
5. Record the season playlist ID/URL under the season heading in `seasons.md`.

Example result:

```json
{
  "ok": true,
  "season": 1,
  "playlistName": "SUB/WAVE Docs · Season 01 — Making Of Episodes",
  "playlistId": "...",
  "trackCount": 3,
  "tracks": [
    {
      "trackNumber": 1,
      "title": "SUB/WAVE Docs · S01E01 — Punisher (Making Of)",
      "songId": "..."
    },
    {
      "trackNumber": 2,
      "title": "SUB/WAVE Docs · S01E02 — Melodrama (Making Of)",
      "songId": "..."
    },
    {
      "trackNumber": 3,
      "title": "SUB/WAVE Docs · S01E03 — Weathervanes (Making Of)",
      "songId": "..."
    }
  ]
}
```

---

# Recommended Audio Format

Prefer **M4A/AAC** for compiled episode tracks.

Reasons:

- Chapter metadata support is better than MP3.
- AAC at 160–192 kbps is efficient for spoken-word + music-doc content.
- Navidrome usually handles M4A cleanly.
- Radio/broadcast consumers generally handle AAC/M4A well, but confirm with the SUB/WAVE radio playback stack.

Fallback option:

- MP3 at 192 kbps if maximum compatibility is needed.
- MP3 chapter support is less reliable, so chapter markers may be skipped or represented via external metadata only.

Recommended default:

```text
outputFormat: m4a
codec: aac
bitrate: 192k
```

---

# File Organization

Use a stable folder under the Navidrome Music library.

Suggested path:

```text
<MusicLibraryRoot>/
  SUB-WAVE Documentaries/
    SUB-WAVE Docs/
      01 - SUB-WAVE Docs · S01E01 — Punisher (Making Of).m4a
      02 - SUB-WAVE Docs · S01E02 — Melodrama (Making Of).m4a
      03 - SUB-WAVE Docs · S01E03 — Weathervanes (Making Of).m4a
```

Important:

- Filesystem folder uses `SUB-WAVE` with hyphen for portability.
- Tags use `SUB/WAVE` with slash:

```text
Artist: SUB/WAVE Documentaries
Album Artist: SUB/WAVE Documentaries
Album: SUB/WAVE Docs
```

Sanitize filenames for filesystem safety while preserving the full title in tags.

Example filename sanitization:

```text
01 - SUB-WAVE Docs · S01E01 — Punisher (Making Of).m4a
```

while tag title remains:

```text
SUB/WAVE Docs · S01E01 — Punisher (Making Of)
```

---

# Metadata Requirements

For each compiled track:

```text
title        = playlist name / episode name
artist       = SUB/WAVE Documentaries
album_artist = SUB/WAVE Documentaries
album        = SUB/WAVE Docs
track        = episode number, preferably zero-padded display but numeric tag
disc         = season number if useful
date/year    = production or publish year if known
genre        = Music Documentary
comment      = Compiled from SUB/WAVE making-of episode playlist
```

Optional custom tags:

```text
SUBWAVE_SEASON=1
SUBWAVE_EPISODE=1
SUBWAVE_SOURCE_PLAYLIST_ID=MJujkaoQDFwEdnHfmGRqVv
SUBWAVE_KIND=making-of-compiled
```

If using M4A, map custom metadata carefully; ffmpeg may not preserve arbitrary tags unless using compatible atoms or `-movflags use_metadata_tags`.

Recommended ffmpeg metadata flags for M4A:

```bash
-movflags use_metadata_tags
```

---

# Chapter Marker Support

## Requirement

If `includeChapters: true`, embed chapters in the compiled M4A corresponding to the original playlist entries or rundown cue items.

Each chapter should include:

- start time
- end time
- title

Chapter titles should preferably come from the original cue/rundown item labels, not just raw filenames.

Example chapters:

```text
00:00:00 Intro
00:03:04 Motion Sickness
00:06:42 Segment 2
...
```

## ffmetadata Format

Generate an ffmetadata file:

```ini
;FFMETADATA1
title=SUB/WAVE Docs · S01E01 — Punisher (Making Of)
artist=SUB/WAVE Documentaries
album=SUB/WAVE Docs

[CHAPTER]
TIMEBASE=1/1000
START=0
END=184000
title=Intro

[CHAPTER]
TIMEBASE=1/1000
START=184000
END=402000
title=Motion Sickness
```

Then mux with audio:

```bash
ffmpeg \
  -f concat -safe 0 -i concat.txt \
  -i metadata.ffmeta \
  -map_metadata 1 \
  -map_chapters 1 \
  -vn \
  -c:a aac -b:a 192k \
  -movflags use_metadata_tags \
  output.m4a
```

However, validate this exact invocation. Depending on the ffmpeg version, a safer two-step process may be:

### Step 1: compile audio

```bash
ffmpeg \
  -f concat -safe 0 -i concat.txt \
  -vn \
  -c:a aac -b:a 192k \
  temp_audio.m4a
```

### Step 2: mux metadata + chapters

```bash
ffmpeg \
  -i temp_audio.m4a \
  -i metadata.ffmeta \
  -map 0:a \
  -map_metadata 1 \
  -map_chapters 1 \
  -c copy \
  -movflags use_metadata_tags \
  output.m4a
```

The two-step process is likely more robust.

---

# Source Resolution

The tool needs to resolve each playlist entry into an actual readable source file.

Possible sources:

1. Navidrome playlist API:
   - Fetch playlist entries.
   - Each entry may include `path`, `id`, `title`, `duration`, `suffix`.
2. Subsonic stream endpoint:
   - Could theoretically stream each song and concatenate downloaded temporary files.
   - Less ideal, because it may transcode or lose source quality.
3. Direct filesystem:
   - Preferred if the MCP host has access to the Navidrome Music root/NAS mount.

Recommended:

- Use direct filesystem paths when possible.
- Require pipeline config to know the Navidrome music root path as seen by:
  - Navidrome, and
  - the MCP host / PVE host / NAS mount.

If paths differ between Navidrome and the pipeline host, add a configurable path mapping:

```yaml
navidrome:
  music_root_navidrome: /music
  music_root_pipeline: /mnt/nas/Music
```

Then map:

```text
Navidrome path: /music/Artist/Album/file.flac
Pipeline path:  /mnt/nas/Music/Artist/Album/file.flac
```

If Navidrome returns relative paths, join them against `music_root_pipeline`.

---

# ffmpeg Concatenation Details

Use concat demuxer with a generated file list:

```text
file '/absolute/path/one.mp3'
file '/absolute/path/two.flac'
file '/absolute/path/three.m4a'
```

Escape single quotes in paths correctly:

```text
file '/path/it'\''s complicated.flac'
```

Because playlist entries may be mixed codecs/formats, do **not** rely on stream copy.

Use re-encoding:

```bash
ffmpeg \
  -f concat -safe 0 -i concat.txt \
  -vn \
  -c:a aac -b:a 192k \
  temp_audio.m4a
```

Optional loudness normalization is possible but should **not** be default unless reviewed, because the playlist may intentionally preserve reference track loudness differences.

Possible future option:

```ts
loudnessNormalize?: boolean
```

Using:

```bash
-af loudnorm=I=-16:TP=-1.5:LRA=11
```

But leave default off.

---

# Duration Calculation

For chapters, calculate cumulative durations from:

1. `rundown.json` if it contains exact segment durations.
2. `ffprobe` each source file if not.
3. Navidrome playlist entry durations as fallback.

Preferred: `ffprobe`.

Example:

```bash
ffprobe -v error \
  -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 \
  "/path/to/file.m4a"
```

Store milliseconds:

```ts
durationMs = Math.round(seconds * 1000)
```

Build chapters cumulatively:

```ts
startMs = cumulative
endMs = cumulative + durationMs
```

Ensure the final chapter end does not exceed final muxed duration by a meaningful amount.

---

# Navidrome Rescan and Lookup

After writing the compiled track into the Music library:

1. Trigger Navidrome scan.
2. Wait until scan status settles.
3. Resolve the album:

```text
artist: SUB/WAVE Documentaries
album: SUB/WAVE Docs
```

4. Find the new song by:
   - title
   - track number
   - path
   - maybe duration tolerance

Return the `songId`.

When a playlist or compiled track is created by the pipeline, persist the stable
Navidrome IDs/URLs in `seasons.md` immediately. That local, gitignored catalog is
the operational ledger for later compile/backfill/publish operations.

The MCP already has tools/patterns for:

- `stage_audio`
- `wait_scan`
- `navidrome_find_album`
- `navidrome_album_songs`
- `navidrome_create_playlist`
- `publish_episode`

Reuse their Navidrome client/config conventions rather than inventing a separate client.

---

# Idempotency Requirements

Tools should be safe to re-run.

For `compile_playlist_to_track` / `compile_episode_track`:

- If output file exists and `replace: false`, fail with a clear message.
- If output file exists and `replace: true`, overwrite atomically:
  1. Write to temp file in same destination directory.
  2. Validate temp file exists and duration is plausible.
  3. Rename over final path.
- If ffmpeg fails, leave the existing final output untouched.
- Clean temp files where possible.

For `publish_compiled_season_playlist`:

- Should replace an existing playlist with the same name, or update it idempotently.
- Preserve order by track number.
- Never assemble playlist from uncompiled episode segment/reference tracks.
- Record the resulting season playlist ID/URL in `seasons.md`.

---

# Validation / Quality Gates

Before returning success, validate:

## Audio file validation

- Output file exists.
- File size > reasonable threshold, e.g. > 5 MB for a 40m episode.
- Duration is within tolerance of summed source durations.
  - Suggested tolerance: ±2 seconds or ±0.5%.
- ffprobe can read it.
- Audio stream exists.
- Codec matches expected format:
  - M4A/AAC by default.

## Metadata validation

Use `ffprobe` or a tag reader to confirm:

- title
- artist
- album_artist
- album
- track number
- chapters if requested

Example:

```bash
ffprobe -v error \
  -show_entries format_tags:chapters \
  -print_format json \
  output.m4a
```

## Navidrome validation

After rescan:

- Album `SUB/WAVE Docs` by `SUB/WAVE Documentaries` resolves.
- Compiled track appears.
- Returned `songId` corresponds to the compiled file/title.

---

# Suggested MCP Tool Set

## `compile_playlist_to_track`

Compile any Navidrome playlist into one tagged audio file.

Input:

```ts
{
  playlistId: string,
  title?: string,
  album?: string,
  artist?: string,
  albumArtist?: string,
  season?: number,
  episode?: number,
  trackNumber?: number,
  outputFormat?: "m4a" | "mp3",
  includeChapters?: boolean,
  replace?: boolean,
  rescan?: boolean,
  wait?: boolean
}
```

Output:

```ts
{
  ok: boolean,
  playlistId: string,
  playlistName: string,
  outputPath: string,
  outputFormat: string,
  durationSec: number,
  sourceCount: number,
  chapterCount: number,
  artist: string,
  albumArtist: string,
  album: string,
  title: string,
  trackNumber?: number,
  navidromeAlbumId?: string,
  navidromeSongId?: string,
  playlistUrl?: string,
  warnings?: string[]
}
```

## `compile_episode_track`

Compile from an existing SUB/WAVE episode `rundown.json`.

Input:

```ts
{
  rundownPath: string,
  outputFormat?: "m4a" | "mp3",
  includeChapters?: boolean,
  replace?: boolean,
  rescan?: boolean,
  wait?: boolean
}
```

Output similar to `compile_playlist_to_track`.

## `publish_compiled_season_playlist`

Create/update the season playlist containing compiled episode tracks only.

Input:

```ts
{
  season: number,
  name?: string,
  album?: string,
  artist?: string
}
```

Output:

```ts
{
  ok: boolean,
  season: number,
  playlistName: string,
  playlistId: string,
  playlistUrl?: string,
  trackCount: number,
  tracks: [
    {
      trackNumber: number,
      title: string,
      songId: string,
      durationSec?: number
    }
  ],
  warnings?: string[]
}
```

---

# Integration With Existing Production Flow

Current end-to-end flow roughly ends with:

1. `render_episode`
2. `catalog_set_status(..., "recorded")`
3. `stage_audio`
4. `publish_episode`
5. `catalog_set_status(..., "published")`

New optional post-publish flow:

```text
publish_episode(rundownPath)
compile_episode_track(rundownPath, includeChapters=true, rescan=true, wait=true)
publish_compiled_season_playlist(season)
```

Recommended future full flow:

```text
render_episode
wait_render
catalog_set_status(recorded)
stage_audio(replace=true, rescan=true, wait=true)
publish_episode(rundownPath)
compile_episode_track(rundownPath, includeChapters=true, rescan=true, wait=true)
publish_compiled_season_playlist(season)
catalog_set_status(published)
```

Question for implementer: decide whether compiled-track creation should happen **before** or **after** `catalog_set_status(published)`. I’d suggest before final `published`, so “published” means both the cue playlist and compiled season-track are ready.

---

# Backfill Existing Published Episodes

Provide a way to backfill already-published playlist-based episodes.

For backfill, playlist IDs/URLs may be supplied manually. The tool should accept
the explicit ID and can record it in `seasons.md`; it does not need to search
Navidrome playlists by name.

Example tool calls once implemented:

```ts
compile_playlist_to_track({
  playlistId: "MJujkaoQDFwEdnHfmGRqVv",
  season: 1,
  episode: 1,
  includeChapters: true,
  outputFormat: "m4a"
})
```

Then after compiling all episodes:

```ts
publish_compiled_season_playlist({
  season: 1
})
```

For backfill, the source of chapter names is only the playlist entries unless `rundown.json` paths are known.

Preferred chapter names:

1. Rundown cue item label, if available.
2. Navidrome song title.
3. Filename stem.

---

# Error Handling

Stop and return a clear failure if:

- Playlist ID does not resolve.
- Playlist has zero tracks.
- Any source file cannot be resolved/read.
- `ffmpeg` or `ffprobe` is missing.
- ffmpeg returns non-zero.
- Output duration is implausible.
- Navidrome rescan fails.
- New compiled track cannot be found after scan.

Do not silently skip playlist entries. If a source is missing, fail closed.

Return warnings for non-blocking issues:

- Chapter metadata requested but not verifiable.
- Could not infer season/episode from title.
- Track number omitted.
- Navidrome scan completed but lookup needed fuzzy title matching.
- Some custom metadata tags may not be visible in Navidrome.

---

# Config Additions

Add or verify config entries for:

```yaml
compiledEpisodes:
  enabled: true
  artist: "SUB/WAVE Documentaries"
  album: "SUB/WAVE Docs"
  outputFormat: "m4a"
  bitrate: "192k"
  includeChapters: true
  outputSubdir: "SUB-WAVE Documentaries/SUB-WAVE Docs"

navidrome:
  baseUrl: "http://192.168.1.110:4533"
  musicRootPipeline: "/path/as/seen/by/pipeline"
  musicRootNavidrome: "/music"
```

If existing pipeline config already stores Navidrome URL and music root, reuse it.

Avoid hard-coding:

```text
192.168.1.110:4533
```

except in local dev examples.

Also extend the local, gitignored `seasons.md` catalog. Episode rows should store
the source episode playlist and compiled song ID:

```md
| Ep | Album | Artist | Host | Status | Dir | Published | Playlist ID | Playlist URL | Compiled Song ID |
```

Season-level compiled playlist metadata should live under the season heading:

```md
## Season 1

Season playlist ID: ...
Season playlist URL: ...
```

---

# Security / Safety

- Do not accept arbitrary output paths outside the configured Music library root.
- Sanitize filenames.
- Avoid shell injection:
  - Use subprocess argument arrays, not shell strings.
  - If writing concat manifests, correctly escape paths.
- Validate that every resolved source file lives under an allowed music root or known pipeline audio staging root.
- Write temp files under a controlled working/temp directory.
- Atomic rename into final location.

---

# Example End-to-End Backfill Scenario

Input:

```text
Playlist:
SUB/WAVE Docs · S01E01 — Punisher (Making Of)
URL:
http://192.168.1.110:4533/app/#/playlist/MJujkaoQDFwEdnHfmGRqVv/show
```

Call:

```ts
compile_playlist_to_track({
  playlistId: "MJujkaoQDFwEdnHfmGRqVv",
  season: 1,
  episode: 1,
  outputFormat: "m4a",
  includeChapters: true,
  replace: true,
  rescan: true,
  wait: true
})
```

Expected file:

```text
SUB-WAVE Documentaries/SUB-WAVE Docs/01 - SUB-WAVE Docs · S01E01 — Punisher (Making Of).m4a
```

Expected tags:

```text
Title: SUB/WAVE Docs · S01E01 — Punisher (Making Of)
Artist: SUB/WAVE Documentaries
Album Artist: SUB/WAVE Documentaries
Album: SUB/WAVE Docs
Track: 1
Disc: 1
Genre: Music Documentary
```

Expected chapters:

```text
Chapter 1: playlist item 1
Chapter 2: playlist item 2
...
Chapter 15: playlist item 15
```

Then:

```ts
publish_compiled_season_playlist({
  season: 1
})
```

Expected playlist:

```text
SUB/WAVE Docs · Season 01 — Making Of Episodes
```

containing:

```text
01. SUB/WAVE Docs · S01E01 — Punisher (Making Of)
02. SUB/WAVE Docs · S01E02 — Melodrama (Making Of)
03. SUB/WAVE Docs · S01E03 — Weathervanes (Making Of)
...
```

---

# Implementation Notes

Use existing `subwave-pipeline` MCP patterns for:

- Navidrome auth/client
- scan triggering/waiting
- playlist creation
- staging onto NAS/Music share
- idempotent publish behavior

Do not create a separate disconnected Navidrome implementation if there is already one in the MCP.

The important design invariant:

> The existing detailed episode playlist remains the cue/source playlist; the new compiled track is a derived broadcast artifact.

The compiled season playlist should use only derived single-episode tracks, never the original segments/reference tracks.

---
