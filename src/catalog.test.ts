import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as catalog from "./catalog";

// Sample includes a *fenced* illustrative table whose heading collides with a
// real season, to guard the fence-masking behaviour.
const SAMPLE = [
  "# SUB/WAVE Documentaries — Catalog",
  "",
  "**Active season: 2**",
  "",
  "Some prose paragraph that must be preserved verbatim.",
  "",
  "Format reference (illustrative — not live episodes):",
  "",
  "```",
  "## Season 1 — <optional theme>",
  "",
  "| Ep | Album | Artist | Host | Status | Dir | Published |",
  "| -- | ----- | ------ | ---- | ------ | --- | --------- |",
  "| 01 | Fake | Nobody | Cara | published | S01E01-fake | 2020-01-01 |",
  "| 02 | Fake2 | Nobody | Cara | planned | — | — |",
  "```",
  "",
  "## Season 1",
  "",
  "| Ep | Album | Artist | Host | Status | Dir | Published |",
  "| -- | ----- | ------ | ---- | ------ | --- | --------- |",
  "| *(no episodes yet — the first production becomes Ep 01)* | | | | | | |",
  "",
  "## Season 2",
  "",
  "| Ep | Album | Artist | Host | Status | Dir | Published |",
  "| -- | ----- | ------ | ---- | ------ | --- | --------- |",
  "| 01 | Real One | Someone | Jools | published | S02E01-real-one | 2026-01-01 |",
  "",
].join("\n");

function tmpCatalog(content = SAMPLE): string {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const p = join(dir, "seasons.md");
  writeFileSync(p, content, "utf-8");
  return p;
}

describe("slug", () => {
  it("basic", () => expect(catalog.slug("In Rainbows")).toBe("in-rainbows"));
  it("punctuation and case", () => expect(catalog.slug("OK Computer!!!")).toBe("ok-computer"));
  it("empty falls back", () => expect(catalog.slug("   ")).toBe("untitled"));
});

describe("read", () => {
  const text = SAMPLE;

  it("active season", () => expect(catalog.activeSeason(text)).toBe(2));

  it("fenced example ignored for season 1", () => {
    expect(catalog.nextEpisode(text, 1)).toBe(1);
    expect(catalog.rowsForSeason(text, 1)).toEqual([]);
  });

  it("next episode season 2", () => expect(catalog.nextEpisode(text, 2)).toBe(2));

  it("rows for season 2", () => {
    const rows = catalog.rowsForSeason(text, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.album).toBe("Real One");
    expect(rows[0]!.ep).toBe(1);
    expect(rows[0]!.status).toBe("published");
  });

  it("missing season throws", () => {
    expect(() => catalog.rowsForSeason(text, 9)).toThrow(catalog.CatalogError);
  });
});

describe("nextPlanned", () => {
  // Season 3: two done rows then two planned — the FIRST planned wins, and it's
  // distinct from nextEpisode (the append counter).
  const planned = [
    "**Active season: 3**",
    "",
    "## Season 3",
    "",
    "| Ep | Album | Artist | Host | Status | Dir | Published |",
    "| -- | ----- | ------ | ---- | ------ | --- | --------- |",
    "| 01 | A | X | Cara | published | S03E01-a | 2026-02-01 |",
    "| 02 | B | Y | Jools | recorded | S03E02-b | — |",
    "| 03 | C | Z | Cara | planned | — | — |",
    "| 04 | D | W | Jools | planned | — | — |",
    "",
  ].join("\n");

  it("returns the first planned row, not the append number", () => {
    const row = catalog.nextPlanned(planned, 3);
    expect(row?.ep).toBe(3);
    expect(row?.album).toBe("C");
    // append counter would be 5 — deliberately different from the planned answer.
    expect(catalog.nextEpisode(planned, 3)).toBe(5);
  });

  it("returns null when nothing is planned", () => {
    const done = planned.replace(/planned/g, "published");
    expect(catalog.nextPlanned(done, 3)).toBeNull();
  });
});

describe("assign — append", () => {
  it("replaces the placeholder", () => {
    const p = tmpCatalog();
    const res = catalog.assign("In Rainbows", "Radiohead", "Cara", 1, p);
    expect(res.action).toBe("appended");
    expect(res.episode).toBe(1);
    expect(res.dir).toBe("S01E01-in-rainbows");
    const rows = catalog.rowsForSeason(catalog.read(p), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("in-production");
    expect(rows[0]!.host).toBe("Cara");
  });

  it("second append increments", () => {
    const p = tmpCatalog();
    catalog.assign("A", "B", "Cara", 1, p);
    const res = catalog.assign("C", "D", "Jools", 1, p);
    expect(res.episode).toBe(2);
    expect(catalog.rowsForSeason(catalog.read(p), 1)).toHaveLength(2);
  });

  it("defaults to the active season", () => {
    const p = tmpCatalog();
    const res = catalog.assign("X", "Y", "Cara", undefined, p);
    expect(res.season).toBe(2);
    expect(res.episode).toBe(2);
  });
});

describe("assign — claim", () => {
  it("claims a planned row (case-insensitive, host override, no duplicate)", () => {
    const p = tmpCatalog();
    catalog.assign("Blonde", "Frank Ocean", "Cara", 2, p); // appends E02
    catalog.setStatus(2, 2, "planned", undefined, p); // mark planned
    const res = catalog.assign("blonde", "FRANK OCEAN", "Jools", 2, p);
    expect(res.action).toBe("claimed");
    expect(res.episode).toBe(2);
    const blonde = catalog.rowsForSeason(catalog.read(p), 2).filter((r) => r.album.toLowerCase() === "blonde");
    expect(blonde).toHaveLength(1);
    expect(blonde[0]!.host).toBe("Jools");
    expect(blonde[0]!.status).toBe("in-production");
    expect(blonde[0]!.dir).toBe("S02E02-blonde");
  });
});

describe("setStatus", () => {
  it("sets status and published", () => {
    const p = tmpCatalog();
    catalog.setStatus(2, 1, "published", "2026-07-20", p);
    const row = catalog.rowsForSeason(catalog.read(p), 2)[0]!;
    expect(row.status).toBe("published");
    expect(row.published).toBe("2026-07-20");
  });

  it("throws for a missing episode", () => {
    const p = tmpCatalog();
    expect(() => catalog.setStatus(2, 99, "published", undefined, p)).toThrow(catalog.CatalogError);
  });
});

describe("prose + fence preservation", () => {
  it("mutation leaves prose and the fenced example intact", () => {
    const p = tmpCatalog();
    catalog.assign("In Rainbows", "Radiohead", "Cara", 1, p);
    const after = catalog.read(p);
    expect(after).toContain("Some prose paragraph that must be preserved verbatim.");
    expect(after).toContain("Active season: 2");
    expect(after).toContain("## Season 1 — <optional theme>");
    expect(after).toContain("| 01 | Fake | Nobody");
    const realS1 = after.split("## Season 1\n")[1]!.split("## Season 2")[0]!;
    expect(realS1).not.toContain("no episodes yet");
    expect(realS1).toContain("In Rainbows");
  });
});
