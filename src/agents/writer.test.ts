import { describe, expect, it } from "vitest";

import * as lint from "../lint";
import * as sm from "../scriptmodel";
import { buildWriterMessage, capSongSlots, keepIndices, stripSpokenMarkdown, type WriterInput } from "./writer";

const BASE: WriterInput = {
  album: "Weathervanes",
  artist: "Jason Isbell and the 400 Unit",
  host: "p_cara",
  hostName: "Cara",
  season: 1,
  episode: 3,
  research: [
    "# Research",
    "Some facts here.",
    "## Track Lyrics",
    "### Death Wish",
    "Got a picture of you dying in my mind",
  ].join("\n"),
};

describe("buildWriterMessage", () => {
  it("fresh mode: full-write instruction, the research, and no revision block", () => {
    const msg = buildWriterMessage(BASE);
    expect(msg).toContain("Write the FULL 25-minute script now");
    expect(msg).toContain("TRACK-BY-TRACK MAKING-OF WALK"); // length-forcing structure directive
    expect(msg).toContain("AT LEAST 12 SPOKEN parts");
    expect(msg).toContain("RESEARCH NOTES (your only source of facts)");
    expect(msg).not.toContain("REVISION PASS");
    expect(msg).not.toContain("PREVIOUS DRAFT");
    // Lyrics guide reflects the Track Lyrics section.
    expect(msg).toContain("VERBATIM lyrics for these tracks: Death Wish");
  });

  it("revise mode: includes the notes, the prior draft, and a revise-not-regenerate instruction", () => {
    const msg = buildWriterMessage({
      ...BASE,
      revisionNotes: "Quote the lyric verbatim (it is 'Got', not 'I got'); cut the Flaming Lips claim.",
      previousDraft: "--- \nseason: 1\n---\n## [01] SPOKEN · intro\nOld draft body.",
    });
    expect(msg).toContain("REVISION PASS");
    expect(msg).toContain("Do NOT regenerate");
    expect(msg).toContain("cut the Flaming Lips claim");
    expect(msg).toContain("Old draft body.");
    expect(msg).toContain("RESEARCH NOTES"); // still grounded in the notes
    expect(msg).not.toContain("Write the FULL 25-minute script now");
  });

  it("revise mode needs BOTH notes and a draft — notes alone stays fresh", () => {
    const msg = buildWriterMessage({ ...BASE, revisionNotes: "fix things" });
    expect(msg).not.toContain("REVISION PASS");
    expect(msg).toContain("Write the FULL 25-minute script now");
  });
});

describe("stripSpokenMarkdown", () => {
  const script = [
    "---",
    "season: 1",
    "host_name: Cara",
    "reference_tracks: 1",
    "---",
    "## [01] SPOKEN · intro",
    "Welcome to **Subwave**. This is a `great` record — see [the interview](https://x.com).",
    "",
    "## [02] SONG · song-1",
    "- title: Death Wish",
    "- note: features **strings** and a link [x](https://y.com)",
  ].join("\n");

  it("strips *, `, and links from SPOKEN bodies only", () => {
    const out = stripSpokenMarkdown(script);
    expect(out).toContain("Welcome to Subwave. This is a great record — see the interview.");
    // Front matter and SONG metadata are left verbatim (not spoken → not TTS'd).
    expect(out).toContain("- note: features **strings** and a link [x](https://y.com)");
    expect(out).toContain("## [01] SPOKEN · intro"); // heading untouched
  });

  it("leaves clean prose unchanged", () => {
    const clean = "## [01] SPOKEN · intro\nJust clean prose here, nothing to strip.";
    expect(stripSpokenMarkdown(clean)).toBe(clean);
  });

  it("output no longer trips lint's markdown-in-spoken warning", () => {
    const before = lint.lintText(script).some((f) => /SPOKEN body has markdown/.test(f.msg));
    const after = lint.lintText(stripSpokenMarkdown(script)).some((f) => /SPOKEN body has markdown/.test(f.msg));
    expect(before).toBe(true);
    expect(after).toBe(false);
  });
});

describe("capSongSlots", () => {
  // Build a script with N interleaved SONG slots (SPOKEN 01, SONG 02, SPOKEN 03, SONG 04, …).
  const build = (nSongs: number): string => {
    const fm = "---\nseason: 1\nepisode: 1\nalbum: \"A\"\nartist: \"B\"\nhost: p_cara\nhost_name: \"Cara\"\nmodel: eleven_flash_v2_5\ntarget_minutes: 25\nreference_tracks: " + nSongs + "\n---\n";
    const parts: string[] = [fm];
    let idx = 1;
    for (let s = 0; s < nSongs; s++) {
      parts.push(`\n## [${String(idx++).padStart(2, "0")}] SPOKEN · part-${s + 1}\nSome spoken words about track ${s + 1}.\n`);
      parts.push(`\n## [${String(idx++).padStart(2, "0")}] SONG · song-${s + 1}\n- title: "Track ${s + 1}"\n- artist: "B"\n`);
    }
    parts.push(`\n## [${String(idx++).padStart(2, "0")}] SPOKEN · outro\nThanks.\n`);
    return parts.join("");
  };

  it("keepIndices spreads evenly and keeps first + last", () => {
    expect(keepIndices(8, 5)).toEqual([0, 2, 4, 5, 7]);
    expect(keepIndices(3, 5)).toEqual([0, 1, 2]); // fewer than max → keep all
    const k = keepIndices(8, 5);
    expect(k[0]).toBe(0);
    expect(k[k.length - 1]).toBe(7);
  });

  it("caps 8 songs to 5 and renumbers contiguously", () => {
    const capped = capSongSlots(build(8));
    const ep = sm.parse(capped);
    expect(sm.songSlots(ep).length).toBe(5);
    // Indices are contiguous 1..N.
    expect(ep.slots.map((s) => s.index)).toEqual(ep.slots.map((_, i) => i + 1));
  });

  it("the capped script passes lint's song-count + index rules", () => {
    // reference_tracks is reconciled in writeScript; set it to the post-cap count here.
    const capped = capSongSlots(build(8)).replace(/^reference_tracks:.*$/m, "reference_tracks: 5");
    const f = lint.lintText(capped);
    expect(f.some((x) => /reference songs/.test(x.msg))).toBe(false);
    expect(f.some((x) => x.level === "ERROR")).toBe(false);
  });

  it("leaves a script with ≤5 songs untouched", () => {
    const four = build(4);
    expect(capSongSlots(four)).toBe(four);
  });
});
