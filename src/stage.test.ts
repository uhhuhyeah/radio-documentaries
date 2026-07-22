import { describe, expect, it } from "vitest";

import { stageDest, staleFiles } from "./stage";

describe("stageDest", () => {
  const base = "/mnt/nas/music/subwave-documentaries";

  it("builds <musicDir>/<lowercased episode dir name>", () => {
    expect(stageDest("S01E01-punisher", base)).toBe(`${base}/s01e01-punisher`);
  });

  it("uses the basename of a full path and trims trailing slashes", () => {
    expect(stageDest("/repo/S02E03-blonde/", `${base}/`)).toBe(`${base}/s02e03-blonde`);
  });
});

describe("staleFiles", () => {
  it("returns dest files not present in the source set", () => {
    expect(staleFiles(["a.mp3", "b.mp3"], ["a.mp3", "b.mp3", "old.mp3"])).toEqual(["old.mp3"]);
  });

  it("returns [] when dest matches source (a clean re-stage)", () => {
    expect(staleFiles(["a.mp3", "b.mp3"], ["a.mp3", "b.mp3"])).toEqual([]);
  });

  it("returns [] when dest is empty (first stage)", () => {
    expect(staleFiles(["a.mp3"], [])).toEqual([]);
  });
});
