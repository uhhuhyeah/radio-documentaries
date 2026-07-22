import { describe, expect, it } from "vitest";

import { buildWriterMessage, type WriterInput } from "./writer";

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
