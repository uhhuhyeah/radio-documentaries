import { describe, expect, it } from "vitest";

import { plainLyrics } from "./lyrics";

describe("plainLyrics", () => {
  it("returns trimmed plain lyrics", () => {
    expect(plainLyrics({ plainLyrics: "Day off in Kyoto\nGot bored\n" })).toBe("Day off in Kyoto\nGot bored");
  });
  it("returns null for an instrumental", () => {
    expect(plainLyrics({ instrumental: true, plainLyrics: "" })).toBeNull();
  });
  it("returns null when there are no plain lyrics", () => {
    expect(plainLyrics({ plainLyrics: "" })).toBeNull();
    expect(plainLyrics({ syncedLyrics: "[00:01]x" })).toBeNull();
    expect(plainLyrics(null)).toBeNull();
  });
});
