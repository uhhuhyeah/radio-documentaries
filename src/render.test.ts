import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ttsBody, ttsUrl, voiceSettings } from "./elevenlabs";
import { MIN_SEGMENT_BYTES, planEpisode, reconcileAudioDir, sanitizeForTts, segmentsToRender } from "./render";
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

describe("reconcileAudioDir", () => {
  let dir: string;
  const touch = (name: string) => writeFileSync(join(dir, name), "x");
  const listMp3 = () => readdirSync(dir).filter((f) => f.endsWith(".mp3")).sort();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes orphaned segments the current plan no longer produces", () => {
    const expected = planEpisode(clean()).steps.map((s) => s.filename);
    // A real plan file that survives, plus orphans from a pre-restructure render
    // (the shape of the S01E01-punisher stragglers: indices/labels the new plan
    // no longer emits).
    touch("s01e01_01_intro.mp3"); // in the plan → kept
    for (const f of ["s01e01_07_part-4.mp3", "s01e01_09_part-5.mp3", "s01e01_11_conclusion.mp3"]) touch(f);

    const removed = reconcileAudioDir(dir, expected).sort();

    expect(removed).toEqual(["s01e01_07_part-4.mp3", "s01e01_09_part-5.mp3", "s01e01_11_conclusion.mp3"]);
    // intro survives (still in the plan); nothing outside the plan is left on disk.
    expect(listMp3()).toEqual(["s01e01_01_intro.mp3"]);
  });

  it("keeps every file the plan produces, deleting nothing when the dir already matches", () => {
    const expected = planEpisode(clean()).steps.map((s) => s.filename);
    for (const f of expected) touch(f);

    expect(reconcileAudioDir(dir, expected)).toEqual([]);
    expect(listMp3()).toEqual([...expected].sort());
  });

  it("leaves non-mp3 sidecar files (rundown.json, .keep) untouched", () => {
    touch("s01e01_99_stale.mp3");
    writeFileSync(join(dir, "rundown.json"), "{}");
    writeFileSync(join(dir, ".keep"), "");

    const removed = reconcileAudioDir(dir, []);

    expect(removed).toEqual(["s01e01_99_stale.mp3"]);
    expect(readdirSync(dir).sort()).toEqual([".keep", "rundown.json"]);
  });

  it("returns empty (no throw) when the audio dir does not exist yet", () => {
    expect(reconcileAudioDir(join(dir, "nope"), ["a.mp3"])).toEqual([]);
  });
});

describe("segmentsToRender (resume decision)", () => {
  const plan = planEpisode(clean());
  const files = plan.steps.map((s) => s.filename); // 4 spoken segments
  const big = MIN_SEGMENT_BYTES * 10; // a comfortably-complete segment
  const present = (m: Record<string, number>): Map<string, number> => new Map(Object.entries(m));

  it("renders every segment when the dir is empty (nothing to resume from)", () => {
    expect(segmentsToRender(plan, present({})).map((s) => s.filename)).toEqual(files);
  });

  it("renders nothing when every segment is already present and complete (idempotent re-run)", () => {
    const all = present(Object.fromEntries(files.map((f) => [f, big])));
    expect(segmentsToRender(plan, all)).toEqual([]);
  });

  it("renders only the missing segments, skipping the complete ones a prior run left", () => {
    // First two rendered before the crash; last two never written.
    const partial = present({ [files[0]!]: big, [files[1]!]: big });
    expect(segmentsToRender(plan, partial).map((s) => s.filename)).toEqual([files[2]!, files[3]!]);
  });

  it("re-renders a present-but-truncated (empty / mid-write) segment", () => {
    const partial = present({
      [files[0]!]: big, // complete → skip
      [files[1]!]: 0, // 0-byte stub → re-render
      [files[2]!]: MIN_SEGMENT_BYTES - 1, // under the floor (truncated) → re-render
      [files[3]!]: big, // complete → skip
    });
    expect(segmentsToRender(plan, partial).map((s) => s.filename)).toEqual([files[1]!, files[2]!]);
  });

  it("treats a file exactly at the size floor as complete", () => {
    const partial = present(Object.fromEntries(files.map((f) => [f, MIN_SEGMENT_BYTES])));
    expect(segmentsToRender(plan, partial)).toEqual([]);
  });

  it("force renders all segments even when every file is present and complete", () => {
    const all = present(Object.fromEntries(files.map((f) => [f, big])));
    expect(segmentsToRender(plan, all, { force: true }).map((s) => s.filename)).toEqual(files);
  });

  it("honours a custom min-size floor", () => {
    const partial = present(Object.fromEntries(files.map((f) => [f, 2048])));
    // With a higher floor, the 2 KB files count as truncated and all re-render.
    expect(segmentsToRender(plan, partial, { minBytes: 4096 }).map((s) => s.filename)).toEqual(files);
  });
});

describe("sanitizeForTts", () => {
  it("strips emphasis and code markers", () => {
    expect(sanitizeForTts("It's *Punisher*, her `second` album.")).toBe("It's Punisher, her second album.");
  });
  it("unwraps markdown links to their text", () => {
    expect(sanitizeForTts("see [Sound City](https://x.com) studios.")).toBe("see Sound City studios.");
  });
  it("strips underscore emphasis but keeps normal prose", () => {
    expect(sanitizeForTts("a _quiet_ record.")).toBe("a quiet record.");
  });
  it("leaves clean prose untouched", () => {
    expect(sanitizeForTts("Just clean words here.")).toBe("Just clean words here.");
  });

  it("preserves an ellipsis beat and the terminal period", () => {
    expect(sanitizeForTts("the accidents are sometimes the point.")).toBe(
      "the accidents are sometimes the point.",
    );
    expect(sanitizeForTts("a low, insomniac hum... under it all.")).toBe(
      "a low, insomniac hum... under it all.",
    );
  });

  it("folds em/en dashes into commas so no dangling pause remains", () => {
    expect(sanitizeForTts("tracked late—a whim—it became the character.")).toBe(
      "tracked late, a whim, it became the character.",
    );
    expect(sanitizeForTts("the gaps of other people's tours – hotel rooms.")).toBe(
      "the gaps of other people's tours, hotel rooms.",
    );
  });

  it("drops a trailing slot separator that leaked into the body", () => {
    expect(sanitizeForTts("Stay with me.\n\n---")).toBe("Stay with me.");
    expect(sanitizeForTts("keep digging for the good stuff.\n***")).toBe(
      "keep digging for the good stuff.",
    );
  });

  it("collapses markdown hard-break trailing spaces", () => {
    expect(sanitizeForTts("a low, insomniac hum  \nrunning under it.")).toBe(
      "a low, insomniac hum\nrunning under it.",
    );
  });

  // The two tails that triggered the Flash v2.5 hallucination in S01E01-punisher:
  // both trailed off non-terminal (a dangling dash / stray separator), giving the
  // model an open-ended prompt. Normalization must close them off.
  it("closes off a segment ending on a dangling dash (the part-3 tail)", () => {
    expect(sanitizeForTts("This first one grew out of exactly that restlessness —")).toBe(
      "This first one grew out of exactly that restlessness.",
    );
  });

  it("closes off a segment ending on a separator with no punctuation (the part-4 tail)", () => {
    expect(sanitizeForTts("the accidents are sometimes the point\n\n---")).toBe(
      "the accidents are sometimes the point.",
    );
  });

  it("adds terminal punctuation when a segment just trails off", () => {
    expect(sanitizeForTts("and that was that")).toBe("and that was that.");
    expect(sanitizeForTts("she wrote it in tour vans,")).toBe("she wrote it in tour vans.");
  });

  it("keeps existing terminal punctuation and closing quotes intact", () => {
    expect(sanitizeForTts('he called it "the closer."')).toBe('he called it "the closer."');
    expect(sanitizeForTts("Is that the end?")).toBe("Is that the end?");
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
