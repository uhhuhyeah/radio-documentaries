import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { budgetEstimateTool, catalogNextTool, lintScriptTool } from "./index";

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

describe("catalog_next tool", () => {
  it("returns a number for the active season", async () => {
    const res = await run(catalogNextTool, {});
    expect(typeof res.details.next).toBe("number");
    expect(res.details.next).toBeGreaterThanOrEqual(1);
  });
});
