import { describe, expect, it } from "vitest";

import * as budget from "./budget";

const SPOKEN_A = "abcde fghij"; // 11 chars, 2 words
const SPOKEN_B = "one two three"; // 13 chars, 3 words
const SAMPLE = [
  "---",
  "model: eleven_flash_v2_5",
  "reference_tracks: 1",
  "---",
  "",
  "## [01] SPOKEN · intro",
  SPOKEN_A,
  "## [02] SONG · song-1",
  '- title: "X"',
  "## [03] SPOKEN · outro",
  SPOKEN_B,
  "",
].join("\n");

const TOTAL_CHARS = SPOKEN_A.length + SPOKEN_B.length; // 24
const TOTAL_WORDS = 5;

describe("estimateText", () => {
  const e = budget.estimateText(SAMPLE);

  it("counts only spoken chars (song title excluded)", () => {
    expect(e.chars).toBe(TOTAL_CHARS);
  });

  it("counts words", () => {
    expect(e.words).toBe(TOTAL_WORDS);
  });

  it("computes credits per model", () => {
    expect(e.creditsByModel.eleven_flash_v2_5).toBeCloseTo(TOTAL_CHARS * 0.5);
    expect(e.creditsByModel.eleven_multilingual_v2).toBeCloseTo(TOTAL_CHARS * 1.0);
  });

  it("reports the chosen model's credits", () => {
    expect(e.chosenModel).toBe("eleven_flash_v2_5");
    expect(e.chosenCredits).toBeCloseTo(TOTAL_CHARS * 0.5);
  });
});

describe("unknown chosen model", () => {
  it("has no chosen credits", () => {
    const e = budget.estimateText(SAMPLE.replace("eleven_flash_v2_5", "eleven_bogus"));
    expect(e.chosenCredits).toBeUndefined();
  });
});

describe("withinCap", () => {
  const e = budget.estimateText(SAMPLE); // chosenCredits = 12
  it("passes under the cap", () => expect(budget.withinCap(e, 999_999)).toBe(true));
  it("fails over the cap", () => expect(budget.withinCap(e, 1)).toBe(false));
  it("returns null when the model is unknown", () => {
    const unknown = budget.estimateText(SAMPLE.replace("eleven_flash_v2_5", "eleven_bogus"));
    expect(budget.withinCap(unknown, 10)).toBeNull();
  });
});
