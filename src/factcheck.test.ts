import { describe, expect, it } from "vitest";

import { dropUnquotedFindings, normalizeForMatch, parseFindings, type ScriptFinding } from "./factcheck";

describe("parseFindings", () => {
  it("parses a clean JSON array", () => {
    const reply = JSON.stringify([
      { severity: "UNSUPPORTED", quote: "Lisa Marie's museum", issue: "Not in research." },
      { severity: "CONTRADICTION", quote: "Rumours was tracked there", issue: "Research says the self-titled album." },
    ]);
    const out = parseFindings(reply);
    expect(out).toHaveLength(2);
    // Contradictions sort first.
    expect(out[0]!.severity).toBe("CONTRADICTION");
    expect(out[1]!.severity).toBe("UNSUPPORTED");
  });

  it("tolerates prose and code fences around the array", () => {
    const reply = 'Here are my findings:\n```json\n[{"severity":"UNSUPPORTED","quote":"x","issue":"y"}]\n```\nDone.';
    const out = parseFindings(reply);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ severity: "UNSUPPORTED", quote: "x", issue: "y", category: "other" });
  });

  it("returns [] for the clean-bill-of-health empty array", () => {
    expect(parseFindings("[]")).toEqual([]);
    expect(parseFindings("All good!\n[]")).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const reply = JSON.stringify([
      { severity: "BOGUS", quote: "a", issue: "b" }, // bad severity
      { severity: "UNSUPPORTED", quote: "", issue: "b" }, // empty quote
      { severity: "CONTRADICTION", quote: "keep", issue: "me" }, // valid
      { quote: "no severity", issue: "b" }, // missing severity
    ]);
    expect(parseFindings(reply)).toEqual([{ severity: "CONTRADICTION", quote: "keep", issue: "me", category: "other" }]);
  });

  it("returns [] on non-JSON, non-array, or absent brackets", () => {
    expect(parseFindings("no brackets here")).toEqual([]);
    expect(parseFindings("[not json]")).toEqual([]);
    expect(parseFindings('{"severity":"UNSUPPORTED"}')).toEqual([]);
    expect(parseFindings("")).toEqual([]);
  });

  it("parses category and confidence when present", () => {
    const reply = JSON.stringify([
      { severity: "CONTRADICTION", quote: "a Neve console", issue: "Research says API.", category: "gear", confidence: "high" },
    ]);
    const out = parseFindings(reply);
    expect(out[0]).toEqual({
      severity: "CONTRADICTION",
      quote: "a Neve console",
      issue: "Research says API.",
      category: "gear",
      confidence: "high",
    });
  });

  it("defaults category to 'other' and omits confidence when absent", () => {
    const reply = JSON.stringify([{ severity: "UNSUPPORTED", quote: "x", issue: "y" }]);
    const out = parseFindings(reply);
    expect(out[0]!.category).toBe("other");
    expect(out[0]).not.toHaveProperty("confidence");
  });

  it("falls back to defaults on malformed category/confidence", () => {
    const reply = JSON.stringify([
      { severity: "UNSUPPORTED", quote: "x", issue: "y", category: "bogus", confidence: "maybe" },
    ]);
    const out = parseFindings(reply);
    expect(out[0]!.category).toBe("other");
    expect(out[0]).not.toHaveProperty("confidence");
  });
});

const finding = (quote: string): ScriptFinding => ({
  severity: "UNSUPPORTED",
  quote,
  issue: "test",
  category: "other",
});

describe("normalizeForMatch", () => {
  it("unifies smart quotes, collapses whitespace, and lowercases", () => {
    expect(normalizeForMatch("It’s   a  “Test”")).toBe("it's a \"test\"");
  });
});

describe("dropUnquotedFindings", () => {
  const script = 'The band tracked it on a Neve console.\nIt’s a "warm" sound.';

  it("drops a finding whose quote is not in the script", () => {
    const out = dropUnquotedFindings([finding("recorded to a Studer 24-track")], script);
    expect(out).toEqual([]);
  });

  it("keeps a finding whose quote is in the script", () => {
    const out = dropUnquotedFindings([finding("a Neve console")], script);
    expect(out).toHaveLength(1);
  });

  it("keeps a finding modulo normalization (smart quotes, whitespace, case)", () => {
    // Script has a curly apostrophe; the finding uses a straight one and odd spacing/case.
    const out = dropUnquotedFindings([finding("It's a   “warm” SOUND")], script);
    expect(out).toHaveLength(1);
  });

  it("drops a finding with an empty quote", () => {
    expect(dropUnquotedFindings([finding("")], script)).toEqual([]);
  });
});
