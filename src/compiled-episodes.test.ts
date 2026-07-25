import { describe, expect, it } from "vitest";

import {
  chaptersFromSources,
  concatManifestLine,
  ffmpegMetadataArgs,
  ffmetadataText,
  inferEpisodeFromTitle,
  looksLikeSubwaveDocumentaryPath,
  mapNavidromePath,
  matchSiblingSourceFilename,
  matchStagedSegmentFilename,
  normalizeSourceFilenameForMatch,
  outputPathForTrack,
  sanitizeFilename,
  sourceFilenameMatchKeys,
  stagedSegmentPrefix,
} from "./compiled-episodes";

describe("compiled episode helpers", () => {
  it("sanitizes filesystem-hostile title characters while preserving display punctuation", () => {
    expect(sanitizeFilename('SUB/WAVE Docs: S01E01 — "Punisher"?')).toBe("SUB-WAVE Docs- S01E01 — Punisher");
  });

  it("infers season and episode from SUB/WAVE titles", () => {
    expect(inferEpisodeFromTitle("SUB/WAVE Docs · S01E03 — Weathervanes (Making Of)")).toEqual({
      season: 1,
      episode: 3,
    });
    expect(inferEpisodeFromTitle("No episode marker")).toEqual({});
  });

  it("maps Navidrome absolute and relative paths to the pipeline music root", () => {
    expect(mapNavidromePath("/music/Artist/Album/file.flac", "/music", "/mnt/nas/music")).toBe(
      "/mnt/nas/music/Artist/Album/file.flac",
    );
    expect(mapNavidromePath("Artist/Album/file.flac", "/music", "/mnt/nas/music")).toBe(
      "/mnt/nas/music/Artist/Album/file.flac",
    );
  });

  it("builds compiled output paths", () => {
    expect(
      outputPathForTrack(
        "/mnt/nas/music",
        "SUB-WAVE Documentaries/SUB-WAVE Docs",
        "SUB/WAVE Docs · S01E01 — Punisher (Making Of)",
        1,
        "m4a",
      ),
    ).toBe("/mnt/nas/music/SUB-WAVE Documentaries/SUB-WAVE Docs/01 - SUB-WAVE Docs · S01E01 — Punisher (Making Of).m4a");
  });

  it("matches staged SUB/WAVE segment files by season episode and playlist slot", () => {
    expect(stagedSegmentPrefix(1, 4, 2)).toBe("s01e04_02_");
    expect(
      matchStagedSegmentFilename(
        [
          "s01e04_01_intro.mp3",
          "s01e04_02_part-1-green-light.mp3",
          "cover.jpg",
          "s01e04_02_part-1-green-light.wav",
        ],
        1,
        4,
        2,
      ),
    ).toBe("s01e04_02_part-1-green-light.mp3");
  });

  it("only classifies SUB/WAVE documentary paths as staged segment candidates", () => {
    expect(looksLikeSubwaveDocumentaryPath("/mnt/music/SUB_WAVE Documentaries/S01E01 — Punisher/01 - intro.mp3")).toBe(true);
    expect(looksLikeSubwaveDocumentaryPath("/mnt/music/subwave-documentaries/s01e01-punisher/s01e01_01_intro.mp3")).toBe(true);
    expect(looksLikeSubwaveDocumentaryPath("/mnt/music/Lorde/Melodrama/01-01 - Green Light.flac")).toBe(false);
    expect(looksLikeSubwaveDocumentaryPath("/mnt/music/Nine Inch Nails/With Teeth/01-04 - The Hand That Feeds.flac")).toBe(false);
  });

  it("matches sibling album files when Navidrome has a stale filename format", () => {
    expect(normalizeSourceFilenameForMatch("01-01 - DVD Menu-Garden Song.flac")).toBe("dvdmenugardensong");
    expect(normalizeSourceFilenameForMatch("1.01 DVD Menu-Garden Song.flac")).toBe("dvdmenugardensong");
    expect(sourceFilenameMatchKeys("Jason Isbell and the 400 Unit - Weathervanes - 01 Death Wish.flac")).toContain("deathwish");
    expect(sourceFilenameMatchKeys("Lorde_Melodrama_01_Green Light.flac")).toContain("greenlight");
    expect(
      matchSiblingSourceFilename(
        [
          "1.01 DVD Menu-Garden Song.flac",
          "1.02 Kyoto.flac",
        ],
        "01-01 - DVD Menu-Garden Song.flac",
      ),
    ).toBe("1.01 DVD Menu-Garden Song.flac");
    expect(matchSiblingSourceFilename(["04 The Hand That Feeds.flac"], "01-04 - The Hand That Feeds.flac")).toBe(
      "04 The Hand That Feeds.flac",
    );
    expect(matchSiblingSourceFilename(["Jason Isbell and the 400 Unit - Weathervanes - 01 Death Wish.flac"], "01 - Death Wish.flac")).toBe(
      "Jason Isbell and the 400 Unit - Weathervanes - 01 Death Wish.flac",
    );
    expect(matchSiblingSourceFilename(["Lorde_Melodrama_01_Green Light.flac"], "01-01 - Green Light.flac")).toBe(
      "Lorde_Melodrama_01_Green Light.flac",
    );
  });

  it("escapes concat manifest single quotes", () => {
    expect(concatManifestLine("/music/It's Complicated.flac")).toBe("file '/music/It'\\''s Complicated.flac'");
  });

  it("builds cumulative millisecond chapters", () => {
    expect(
      chaptersFromSources([
        { title: "Intro", durationSec: 1.234 },
        { title: "Song", durationSec: 2 },
      ]),
    ).toEqual([
      { title: "Intro", startMs: 0, endMs: 1234 },
      { title: "Song", startMs: 1234, endMs: 3234 },
    ]);
  });

  it("emits ffmetadata with escaped fields and chapters", () => {
    const text = ffmetadataText(
      {
        title: "A=B",
        artist: "SUB/WAVE",
        albumArtist: "SUB/WAVE",
        album: "Docs",
        trackNumber: 1,
      },
      [{ title: "Intro; setup", startMs: 0, endMs: 1000 }],
    );
    expect(text).toContain("title=A\\=B");
    expect(text).toContain("album_artist=SUB/WAVE");
    expect(text).toContain("[CHAPTER]");
    expect(text).toContain("title=Intro\\; setup");
  });

  it("builds explicit ffmpeg metadata args for M4A-compatible standard tags", () => {
    const args = ffmpegMetadataArgs({
      title: "SUB/WAVE Docs · S01E01 — Punisher (Making Of)",
      artist: "SUB/WAVE Documentaries",
      albumArtist: "SUB/WAVE Documentaries",
      album: "SUB/WAVE Docs",
      trackNumber: 1,
      discNumber: 1,
    });
    expect(args).toContain("title=SUB/WAVE Docs · S01E01 — Punisher (Making Of)");
    expect(args).toContain("artist=SUB/WAVE Documentaries");
    expect(args).toContain("album_artist=SUB/WAVE Documentaries");
    expect(args).toContain("albumartist=SUB/WAVE Documentaries");
    expect(args).toContain("album=SUB/WAVE Docs");
    expect(args).toContain("track=1");
    expect(args).not.toContain("-movflags");
    expect(args).not.toContain("use_metadata_tags");
  });
});
