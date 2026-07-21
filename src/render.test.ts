import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ttsBody, ttsUrl, voiceSettings } from "./elevenlabs";
import { planEpisode } from "./render";
import * as sm from "./scriptmodel";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const clean = (): sm.Episode => sm.parse(readFileSync(join(FIX, "clean_script.md"), "utf-8"));

describe("planEpisode", () => {
  const plan = planEpisode(clean());

  it("renders only the 4 spoken slots", () => {
    expect(plan.steps).toHaveLength(4);
    expect(plan.steps.map((s) => s.index)).toEqual([1, 2, 4, 6]);
  });

  it("names files by playback index (gaps where songs sit)", () => {
    expect(plan.steps.map((s) => s.filename)).toEqual([
      "s01e01_01_intro.mp3",
      "s01e01_02_part-1.mp3",
      "s01e01_04_part-2.mp3",
      "s01e01_06_conclusion.mp3",
    ]);
  });

  it("sets next_text between adjacent spoken slots (intro→part-1) but not across a song", () => {
    const intro = plan.steps[0]!; // slot 1, followed by slot 2 (spoken)
    const part1 = plan.steps[1]!; // slot 2, followed by slot 3 (SONG)
    expect(intro.nextText).toContain("gaps of other people");
    expect(part1.nextText).toBeUndefined(); // next slot is a song
    expect(part1.prevText).toContain("Some records"); // prev slot is spoken intro
  });

  it("builds a full cue sheet interleaving spoken files and song references", () => {
    expect(plan.cue.map((c) => c.kind)).toEqual(["SPOKEN", "SPOKEN", "SONG", "SPOKEN", "SONG", "SPOKEN"]);
    const song = plan.cue.find((c) => c.kind === "SONG")!;
    expect(song.song?.title).toBe("Kyoto");
    expect(song.file).toBeUndefined();
    expect(plan.cue[0]!.file).toBe("s01e01_01_intro.mp3");
  });
});

describe("elevenlabs request shaping", () => {
  it("builds the tts url with output format", () => {
    expect(ttsUrl("VID")).toBe("https://api.elevenlabs.io/v1/text-to-speech/VID?output_format=mp3_44100_128");
  });

  it("carries per-persona speed into voice_settings", () => {
    expect(voiceSettings(1.1).speed).toBe(1.1);
    expect(voiceSettings(1.1).use_speaker_boost).toBe(true);
  });

  it("includes stitching fields only when present", () => {
    const bare = ttsBody("hi", "eleven_flash_v2_5", 1.0);
    expect(bare.previous_text).toBeUndefined();
    expect(bare.previous_request_ids).toBeUndefined();

    const stitched = ttsBody("hi", "eleven_flash_v2_5", 1.0, {
      previousText: "before",
      nextText: "after",
      previousRequestIds: ["req_1"],
    });
    expect(stitched.previous_text).toBe("before");
    expect(stitched.next_text).toBe("after");
    expect(stitched.previous_request_ids).toEqual(["req_1"]);
  });

  it("omits an empty previous_request_ids array", () => {
    expect(ttsBody("hi", "m", 1.0, { previousRequestIds: [] }).previous_request_ids).toBeUndefined();
  });
});
