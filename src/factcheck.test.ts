import { describe, expect, it } from "vitest";

import { parseFindings } from "./factcheck";

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
    expect(out[0]).toEqual({ severity: "UNSUPPORTED", quote: "x", issue: "y" });
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
    expect(parseFindings(reply)).toEqual([{ severity: "CONTRADICTION", quote: "keep", issue: "me" }]);
  });

  it("returns [] on non-JSON, non-array, or absent brackets", () => {
    expect(parseFindings("no brackets here")).toEqual([]);
    expect(parseFindings("[not json]")).toEqual([]);
    expect(parseFindings('{"severity":"UNSUPPORTED"}')).toEqual([]);
    expect(parseFindings("")).toEqual([]);
  });
});
