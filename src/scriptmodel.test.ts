import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as sm from "./scriptmodel";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const read = (name: string): string => readFileSync(join(FIX, name), "utf-8");

describe("parseFrontMatter", () => {
  it("keeps quoted strings and coerces ints", () => {
    const fm = sm.parseFrontMatter('album: "Punisher"\nseason: 1\n');
    expect(fm.album).toBe("Punisher");
    expect(fm.season).toBe(1);
  });

  it("strips an inline comment on an unquoted value", () => {
    expect(sm.parseFrontMatter("host: p_jools   # persona id\n").host).toBe("p_jools");
  });

  it("preserves a # inside quotes", () => {
    expect(sm.parseFrontMatter('album: "Sharp #1"\n').album).toBe("Sharp #1");
  });

  it("coerces negative ints", () => {
    expect(sm.parseFrontMatter("x: -3\n").x).toBe(-3);
  });
});

describe("splitFrontMatter", () => {
  it("returns an empty block when absent", () => {
    expect(sm.splitFrontMatter("no front matter here")).toEqual(["", "no front matter here"]);
  });

  it("throws on an unclosed block", () => {
    expect(() => sm.splitFrontMatter("---\nkey: val\nno closing line")).toThrow(sm.ScriptError);
  });
});

describe("parse (clean fixture)", () => {
  const ep = sm.parse(read("clean_script.md"));

  it("finds six slots in the right kinds", () => {
    expect(ep.slots.map((s) => s.kind)).toEqual([
      "SPOKEN",
      "SPOKEN",
      "SONG",
      "SPOKEN",
      "SONG",
      "SPOKEN",
    ]);
  });

  it("has contiguous indices", () => {
    expect(ep.slots.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("captures the SPOKEN body verbatim with no heading leakage", () => {
    const intro = ep.slots[0]!;
    expect(intro.body.startsWith("Some records")).toBe(true);
    expect(intro.body).not.toContain("##");
    expect(intro.body).not.toContain("[01]");
  });

  it("preserves multi-line spoken bodies", () => {
    expect(ep.slots[1]!.body).toContain("\n");
  });

  it("parses SONG metadata and leaves the body empty", () => {
    const song = ep.slots[2]!;
    expect(song.meta.title).toBe("Kyoto");
    expect(song.meta.artist).toBe("Phoebe Bridgers");
    expect(song.meta.album).toBe("Punisher");
    expect(song.body).toBe("");
  });

  it("builds the segment filename", () => {
    expect(sm.segmentFilename(1, 1, ep.slots[1]!)).toBe("s01e01_02_part-1.mp3");
  });

  it("partitions spoken vs song slots", () => {
    expect(sm.spokenSlots(ep)).toHaveLength(4);
    expect(sm.songSlots(ep)).toHaveLength(2);
  });

  it("loads the front matter", () => {
    expect(ep.frontMatter.host).toBe("p_jools");
    expect(ep.frontMatter.reference_tracks).toBe(2);
  });
});

describe("findMalformedHeadings", () => {
  it("detects a typo'd heading", () => {
    const found = sm.findMalformedHeadings("## [01] SPOKEN · ok\nhi\n## [02] SPKOEN · typo\nbad\n");
    expect(found).toHaveLength(1);
    expect(found[0]![1]).toContain("SPKOEN");
  });

  it("finds none in the clean fixture", () => {
    expect(sm.findMalformedHeadings(read("clean_script.md"))).toEqual([]);
  });
});
