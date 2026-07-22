import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as catalog from "../catalog";
import { budgetEstimateTool, lintScriptTool } from "./index";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");

// The execute signature is (toolCallId, params, signal, onUpdate, ctx). Our
// wrappers ignore the last three; a loose call keeps the tests focused on I/O.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: any, params: any): Promise<any> =>
  tool.execute("test-call", params, undefined, undefined, {});

describe("lint_script tool", () => {
  it("reports no errors on the clean fixture", async () => {
    const res = await run(lintScriptTool, { scriptPath: join(FIX, "clean_script.md") });
    expect(res.details.errors).toBe(0);
    expect(res.content[0].text).toContain("lint");
  });

  it("reports errors on the broken fixture", async () => {
    const res = await run(lintScriptTool, { scriptPath: join(FIX, "broken_script.md") });
    expect(res.details.errors).toBeGreaterThan(0);
  });
});

describe("budget_estimate tool", () => {
  it("estimates credits for the clean fixture", async () => {
    const res = await run(budgetEstimateTool, { scriptPath: join(FIX, "clean_script.md") });
    expect(res.details.chosenModel).toBe("eleven_flash_v2_5");
    expect(res.details.chars).toBeGreaterThan(0);
  });

  it("applies a cap", async () => {
    const res = await run(budgetEstimateTool, { scriptPath: join(FIX, "clean_script.md"), cap: 1 });
    expect(res.details.capOk).toBe(false);
  });
});

// catalog_next's tool wrapper reads the git-ignored local seasons.md
// (catalog.DEFAULT_PATH), which is absent on a fresh clone / in CI. Exercise the
// same read → activeSeason → nextEpisode path the tool uses, but against a
// checked-in fixture so the suite is green without the local file.
describe("catalog next-episode", () => {
  const text = catalog.read(join(FIX, "seasons.md"));

  it("resolves the next episode for the active season", () => {
    const season = catalog.activeSeason(text);
    expect(season).toBe(2);
    // Season 2 has Ep 01 and 02 in the fixture → next is 3.
    expect(catalog.nextEpisode(text, season)).toBe(3);
  });

  it("resolves the next episode for an explicit season", () => {
    // Season 1 has only Ep 01 → next is 2.
    expect(catalog.nextEpisode(text, 1)).toBe(2);
  });
});
