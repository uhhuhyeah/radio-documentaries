import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as lint from "./lint";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const read = (name: string): string => readFileSync(join(FIX, name), "utf-8");

const errors = (f: lint.Finding[]): lint.Finding[] => f.filter((x) => x.level === "ERROR");
const has = (f: lint.Finding[], level: lint.Level, substr: string): boolean =>
  f.some((x) => x.level === level && x.msg.includes(substr));

const DEFAULT_FRONT =
  'season: 1\nepisode: 1\nalbum: "A"\nartist: "B"\n' +
  'host: p_jools\nhost_name: "Jools"\nmodel: eleven_flash_v2_5\n' +
  "target_minutes: 25\nreference_tracks: 1\n";
const DEFAULT_SLOTS =
  "## [01] SPOKEN · intro\nSome words here to fill the spoken body nicely.\n" +
  '## [02] SONG · song-1\n- title: "X"\n- artist: "Y"\n- album: "Z"\n';

const script = (front = DEFAULT_FRONT, slots = DEFAULT_SLOTS): string => `---\n${front}---\n\n${slots}`;

describe("clean fixture", () => {
  it("has no errors", () => {
    expect(errors(lint.lintFile(join(FIX, "clean_script.md")))).toEqual([]);
  });
});

describe("broken fixture", () => {
  const f = lint.lintFile(join(FIX, "broken_script.md"));

  it("flags the malformed heading", () => expect(has(f, "ERROR", "malformed slot heading")).toBe(true));
  it("flags the missing key", () => expect(has(f, "ERROR", "missing required key: artist")).toBe(true));
  it("flags the invalid host", () => expect(has(f, "ERROR", "not a documentary persona")).toBe(true));
  it("flags non-contiguous indices", () => expect(has(f, "ERROR", "contiguous")).toBe(true));
  it("flags the song missing title", () => expect(has(f, "ERROR", "missing 'title'")).toBe(true));
  it("flags the empty spoken body", () => expect(has(f, "ERROR", "SPOKEN body is empty")).toBe(true));
  it("flags the reference_tracks mismatch", () => expect(has(f, "ERROR", "reference_tracks")).toBe(true));
});

describe("individual rules", () => {
  it("host_name mismatch warns, not errors", () => {
    const f = lint.lintText(script(
      'season: 1\nepisode: 1\nalbum: "A"\nartist: "B"\n' +
      'host: p_jools\nhost_name: "Wrong"\nmodel: eleven_flash_v2_5\n' +
      "target_minutes: 25\nreference_tracks: 1\n"));
    expect(has(f, "WARN", "host_name")).toBe(true);
    expect(errors(f)).toEqual([]);
  });

  it("unknown model warns", () => {
    const f = lint.lintText(script(
      'season: 1\nepisode: 1\nalbum: "A"\nartist: "B"\n' +
      'host: p_jools\nhost_name: "Jools"\nmodel: eleven_bogus_v9\n' +
      "target_minutes: 25\nreference_tracks: 1\n"));
    expect(has(f, "WARN", "not in known set")).toBe(true);
  });

  it("first slot SONG warns", () => {
    const f = lint.lintText(script(DEFAULT_FRONT,
      '## [01] SONG · song-1\n- title: "X"\n- artist: "Y"\n- album: "Z"\n' +
      "## [02] SPOKEN · outro\nSome closing words for the body.\n"));
    expect(has(f, "WARN", "first slot is not SPOKEN")).toBe(true);
  });

  it("non-kebab label warns", () => {
    const f = lint.lintText(script(DEFAULT_FRONT,
      "## [01] SPOKEN · Intro_One\nSome words here.\n" +
      '## [02] SONG · song-1\n- title: "X"\n- artist: "Y"\n- album: "Z"\n'));
    expect(has(f, "WARN", "kebab-case")).toBe(true);
  });

  it("song missing optional album warns, not errors", () => {
    const f = lint.lintText(script(DEFAULT_FRONT,
      "## [01] SPOKEN · intro\nSome words here for the body.\n" +
      '## [02] SONG · song-1\n- title: "X"\n- artist: "Y"\n'));
    expect(has(f, "WARN", "missing 'album'")).toBe(true);
    expect(has(f, "ERROR", "missing 'title'")).toBe(false);
  });

  it("clean minimal script passes", () => {
    expect(errors(lint.lintText(script()))).toEqual([]);
  });

  it("markdown in a spoken body warns, not errors", () => {
    const f = lint.lintText(script(DEFAULT_FRONT,
      "## [01] SPOKEN · intro\nShe made *Punisher* at Sound City.\n" +
      '## [02] SONG · song-1\n- title: "X"\n- artist: "Y"\n- album: "Z"\n'));
    expect(has(f, "WARN", "has markdown")).toBe(true);
    expect(errors(f)).toEqual([]);
  });
});
