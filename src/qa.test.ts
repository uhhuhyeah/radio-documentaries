import { describe, expect, it } from "vitest";

import * as qa from "./qa";

const has = (f: qa.Finding[], level: qa.Level, substr: string): boolean =>
  f.some((x) => x.level === level && x.msg.includes(substr));
const errors = (f: qa.Finding[]): qa.Finding[] => f.filter((x) => x.level === "ERROR");

const RESEARCH =
  "# Notes\n\nSome making-of prose.\n\n" +
  "## Track Lyrics (VERBATIM — the ONLY source for quoting lyrics)\n\n" +
  "### Kyoto\n\nDreaming through Tokyo skyline\nI wanted to see the world\n";

// ~22 spoken minutes at WORDS_PER_MINUTE (150) → inside the 20–30 min house range.
const filler = Array(3300).fill("word").join(" ");
const FRONT =
  'season: 1\nepisode: 1\nalbum: "Punisher"\nartist: "Phoebe Bridgers"\n' +
  'host: p_jools\nhost_name: "Jools"\nmodel: eleven_flash_v2_5\n' +
  "target_minutes: 25\nreference_tracks: 2\n";

const script = (intro: string, part = filler): string =>
  `---\n${FRONT}---\n\n` +
  `## [01] SPOKEN · intro\n${intro}\n\n` +
  `## [02] SONG · song-1\n- title: "Kyoto"\n- artist: "Phoebe Bridgers"\n\n` +
  `## [03] SPOKEN · part-1\n${part}\n\n` +
  `## [04] SONG · song-2\n- title: "I Know the End"\n- artist: "Phoebe Bridgers"\n\n` +
  `## [05] SPOKEN · outro\nThanks for listening.\n`;

const INTRO_OK = "Welcome to Subwave, the making-of hour.";

describe("lyric fidelity", () => {
  it("warns on a quoted lyric that is not in the bank", () => {
    const f = qa.qaText(script(INTRO_OK, 'She sings "the neon lights are burning out tonight" and it aches.'), RESEARCH);
    expect(has(f, "WARN", "fabricated lyric")).toBe(true);
  });

  it("does not warn on a quoted lyric that is verbatim in the bank", () => {
    const f = qa.qaText(script(INTRO_OK, 'She sings "Dreaming through Tokyo skyline I wanted" over that brass.'), RESEARCH);
    expect(has(f, "WARN", "fabricated lyric")).toBe(false);
  });

  it("matches through punctuation and smart-quote differences", () => {
    const f = qa.qaText(script(INTRO_OK, "She sings “dreaming through Tokyo, skyline. I wanted” there."), RESEARCH);
    expect(has(f, "WARN", "fabricated lyric")).toBe(false);
  });

  it("ignores short quoted spans (dialogue, not lyrics)", () => {
    const f = qa.qaText(script(INTRO_OK, 'He called it "a masterpiece" once.'), RESEARCH);
    expect(has(f, "WARN", "fabricated lyric")).toBe(false);
  });

  it("skips the lyric check when the research has no bank", () => {
    const f = qa.qaText(script(INTRO_OK, 'She sings "the neon lights are burning out tonight" and it aches.'), "# Notes\n\nNo lyrics here.\n");
    expect(has(f, "WARN", "fabricated lyric")).toBe(false);
  });
});

describe("station ident", () => {
  it("errors when the intro omits Subwave", () => {
    const f = qa.qaText(script("Welcome to the making-of hour."), RESEARCH);
    expect(has(f, "ERROR", "station ident")).toBe(true);
  });

  it("passes when the intro names Subwave", () => {
    const f = qa.qaText(script(INTRO_OK), RESEARCH);
    expect(has(f, "ERROR", "station ident")).toBe(false);
  });
});

describe("spoken source tags", () => {
  it("errors on a bracketed source tag in a spoken body", () => {
    const f = qa.qaText(script(INTRO_OK, `${filler} It was tracked at Sound City [Wikipedia].`), RESEARCH);
    expect(has(f, "ERROR", "[Wikipedia]")).toBe(true);
  });
});

describe("length", () => {
  it("does not flag an in-range script", () => {
    const f = qa.qaText(script(INTRO_OK), RESEARCH);
    expect(has(f, "WARN", "runtime")).toBe(false);
  });

  it("flags a too-short script", () => {
    const f = qa.qaText(script(INTRO_OK, "A very short body indeed."), RESEARCH);
    expect(has(f, "WARN", "runtime")).toBe(true);
  });

  it("does not flag ~22 spoken min even with four SONG slots (regression: songs are not spoken time)", () => {
    // ~22 spoken min is squarely in range; the old spoken+songs estimate (22 + 4×4 = ~38 min)
    // would have exceeded 30 and warned. Spoken time alone must not.
    const body = Array(3300).fill("word").join(" ");
    const fourSongs =
      `---\n` +
      'season: 1\nepisode: 2\nalbum: "A"\nartist: "B"\n' +
      'host: p_jools\nhost_name: "Jools"\nmodel: eleven_flash_v2_5\n' +
      "target_minutes: 25\nreference_tracks: 4\n" +
      `---\n\n` +
      `## [01] SPOKEN · intro\n${INTRO_OK} ${body}\n\n` +
      `## [02] SONG · song-1\n- title: "Kyoto"\n\n` +
      `## [03] SPOKEN · part-1\nA short bridge.\n\n` +
      `## [04] SONG · song-2\n- title: "Garden Song"\n\n` +
      `## [05] SPOKEN · part-2\nAnother short bridge.\n\n` +
      `## [06] SONG · song-3\n- title: "Punisher"\n\n` +
      `## [07] SPOKEN · part-3\nOne more bridge.\n\n` +
      `## [08] SONG · song-4\n- title: "I Know the End"\n\n` +
      `## [09] SPOKEN · outro\nThanks for listening.\n`;
    expect(has(qa.qaText(fourSongs, RESEARCH), "WARN", "runtime")).toBe(false);
  });
});

describe("reference-track spread", () => {
  it("warns when reference_tracks disagrees with SONG-slot count", () => {
    const bad =
      `---\n` +
      'season: 1\nepisode: 1\nalbum: "A"\nartist: "B"\n' +
      'host: p_jools\nhost_name: "Jools"\nmodel: eleven_flash_v2_5\n' +
      "target_minutes: 25\nreference_tracks: 3\n" +
      `---\n\n` +
      `## [01] SPOKEN · intro\n${INTRO_OK} ${filler}\n\n` +
      `## [02] SONG · song-1\n- title: "Kyoto"\n\n` +
      `## [03] SPOKEN · outro\nThanks.\n`;
    const f = qa.qaText(bad, RESEARCH);
    expect(has(f, "WARN", "reference_tracks=3")).toBe(true);
  });

  it("warns when two SONG slots are adjacent", () => {
    const adjacent =
      `---\n${FRONT}---\n\n` +
      `## [01] SPOKEN · intro\n${INTRO_OK} ${filler}\n\n` +
      `## [02] SONG · song-1\n- title: "Kyoto"\n\n` +
      `## [03] SONG · song-2\n- title: "I Know the End"\n\n` +
      `## [04] SPOKEN · outro\nThanks.\n`;
    const f = qa.qaText(adjacent, RESEARCH);
    expect(has(f, "WARN", "adjacent")).toBe(true);
  });

  it("a clean interleaved script has no errors", () => {
    expect(errors(qa.qaText(script(INTRO_OK), RESEARCH))).toEqual([]);
  });
});
