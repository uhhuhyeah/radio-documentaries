import { describe, expect, it } from "vitest";

import * as lint from "../lint";
import { buildWriterMessage, stripSpokenMarkdown, type WriterInput } from "./writer";

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
