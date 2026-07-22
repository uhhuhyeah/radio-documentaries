import { describe, expect, it } from "vitest";

import { classifyPreflight, DEFAULT_LYRICS_THRESHOLD, missingEnvKeys, type PreflightFacts } from "./preflight";

/** All-green facts; individual tests override just the field under test. */
function facts(over: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    album: { found: true, songCount: 10 },
    lyrics: { withLyrics: 10, total: 10 },
    missingEnv: [],
    ...over,
  };
}

describe("classifyPreflight", () => {
  it("is ok when every check passes", () => {
    const r = classifyPreflight(facts());
    expect(r.ok).toBe(true);
    expect(r.hardFail).toBe(false);
    expect(r.softFail).toBe(false);
    expect(r.checks.map((c) => c.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("hard-fails (album) when the album is not in Navidrome", () => {
    const r = classifyPreflight(facts({ album: { found: false, songCount: 0 } }));
    expect(r.hardFail).toBe(true);
    expect(r.ok).toBe(false);
    const album = r.checks.find((c) => c.name === "album-in-navidrome");
    expect(album?.status).toBe("hard-fail");
  });

  it("soft-fails when the lyrics fraction is below the threshold", () => {
    const r = classifyPreflight(facts({ lyrics: { withLyrics: 5, total: 10 } }), 0.8);
    expect(r.softFail).toBe(true);
    expect(r.hardFail).toBe(false);
    expect(r.ok).toBe(false);
    const lyrics = r.checks.find((c) => c.name === "lyrics-resolve");
    expect(lyrics?.status).toBe("soft-fail");
    expect(lyrics?.detail).toContain("50%");
  });

  it("passes lyrics when the fraction meets the threshold exactly", () => {
    const r = classifyPreflight(facts({ lyrics: { withLyrics: 8, total: 10 } }), 0.8);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "lyrics-resolve")?.status).toBe("pass");
  });

  it("respects a custom, lower threshold", () => {
    const r = classifyPreflight(facts({ lyrics: { withLyrics: 5, total: 10 } }), 0.5);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "lyrics-resolve")?.status).toBe("pass");
  });

  it("defaults the lyrics threshold to 0.8", () => {
    // 7/10 = 0.7 < default 0.8 → soft fail without passing a threshold.
    const r = classifyPreflight(facts({ lyrics: { withLyrics: 7, total: 10 } }));
    expect(DEFAULT_LYRICS_THRESHOLD).toBe(0.8);
    expect(r.softFail).toBe(true);
  });

  it("soft-fails on 0/0 lyrics (the transient all-miss failure)", () => {
    const r = classifyPreflight(facts({ lyrics: { withLyrics: 0, total: 0 } }));
    expect(r.checks.find((c) => c.name === "lyrics-resolve")?.status).toBe("soft-fail");
  });

  it("hard-fails when required env keys are missing", () => {
    const r = classifyPreflight(facts({ missingEnv: ["BRAVE_API_KEY", "NAVIDROME_PASS"] }));
    expect(r.hardFail).toBe(true);
    const env = r.checks.find((c) => c.name === "required-env");
    expect(env?.status).toBe("hard-fail");
    expect(env?.detail).toContain("BRAVE_API_KEY");
  });

  it("hard-fail wins over a concurrent soft-fail", () => {
    const r = classifyPreflight(
      facts({ album: { found: false, songCount: 0 }, lyrics: { withLyrics: 1, total: 10 } }),
    );
    expect(r.hardFail).toBe(true);
    expect(r.softFail).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe("missingEnvKeys", () => {
  it("returns [] when every required key is set", () => {
    expect(
      missingEnvKeys({
        BRAVE_API_KEY: "b",
        OPENROUTER_API_KEY: "o",
        ELEVENLABS_API_KEY: "e",
        NAVIDROME_URL: "http://x",
        NAVIDROME_USER: "u",
        NAVIDROME_PASS: "p",
      }),
    ).toEqual([]);
  });

  it("flags unset and blank keys", () => {
    expect(missingEnvKeys({ BRAVE_API_KEY: "b", NAVIDROME_PASS: "   " })).toEqual([
      "OPENROUTER_API_KEY",
      "ELEVENLABS_API_KEY",
      "NAVIDROME_URL",
      "NAVIDROME_USER",
      "NAVIDROME_PASS",
    ]);
  });
});
