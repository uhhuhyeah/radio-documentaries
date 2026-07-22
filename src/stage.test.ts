import { describe, expect, it } from "vitest";

import { stageDest } from "./stage";

describe("stageDest", () => {
  const base = "/mnt/nas/music/subwave-documentaries";

  it("builds <musicDir>/<lowercased episode dir name>", () => {
    expect(stageDest("S01E01-punisher", base)).toBe(`${base}/s01e01-punisher`);
  });

  it("uses the basename of a full path and trims trailing slashes", () => {
    expect(stageDest("/repo/S02E03-blonde/", `${base}/`)).toBe(`${base}/s02e03-blonde`);
  });
});
