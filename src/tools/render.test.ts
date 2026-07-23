import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeJobStatus } from "../job-status";
import { renderEpisodeTool, renderStatusTool, waitRenderTool } from "./index";

// The execute signature is (toolCallId, params, signal, onUpdate, ctx); the wrappers
// ignore the trailing three — a loose call keeps the tests focused on behaviour.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: any, params: any): Promise<any> => tool.execute("test-call", params, undefined, undefined, {});

const JOB = "render";

let dir: string;
let scriptPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "render-"));
  scriptPath = join(dir, "script.md");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("render_status tool", () => {
  it("reports 'missing' when no render has been started", async () => {
    const res = await run(renderStatusTool, { scriptPath });
    expect(res.details.state).toBe("missing");
  });

  it("reflects the current sentinel state and its render result", async () => {
    writeJobStatus(scriptPath, JOB, {
      state: "done",
      pid: 123,
      startedAt: "t",
      finishedAt: "t2",
      result: { rendered: 12, audioDir: join(dir, "audio"), cuePath: join(dir, "rundown.json") },
    });
    const res = await run(renderStatusTool, { scriptPath });
    expect(res.details.state).toBe("done");
    expect(res.details.result.rendered).toBe(12);
  });
});

describe("wait_render tool", () => {
  it("returns done with the render result when the sentinel is already done", async () => {
    writeJobStatus(scriptPath, JOB, {
      state: "done",
      pid: 123,
      startedAt: "t",
      finishedAt: "t2",
      result: { rendered: 12, audioDir: join(dir, "audio"), cuePath: join(dir, "rundown.json") },
    });
    const res = await run(waitRenderTool, { scriptPath, timeoutSec: 1, intervalSec: 1 });
    expect(res.details.state).toBe("done");
    expect(res.details.result.rendered).toBe(12);
    expect(res.content[0].text).toContain("12 segment(s)");
  });

  it("returns error with the sentinel's message when the render failed", async () => {
    // A credit-guard refusal surfaces exactly like any other failure — message preserved.
    writeJobStatus(scriptPath, JOB, {
      state: "error",
      pid: 123,
      startedAt: "t",
      error: "credit guard: balance 900 < needed 4200",
    });
    const res = await run(waitRenderTool, { scriptPath, timeoutSec: 1, intervalSec: 1 });
    expect(res.details.state).toBe("error");
    expect(res.details.message).toContain("balance 900 < needed 4200");
  });

  it("returns error (stale) when the sentinel says running but the pid is dead", async () => {
    // pid 2^31-1 is effectively never a live process.
    writeJobStatus(scriptPath, JOB, { state: "running", pid: 2_147_483_646, startedAt: "t" });
    const res = await run(waitRenderTool, { scriptPath, timeoutSec: 5, intervalSec: 1 });
    expect(res.details.state).toBe("error");
    expect(res.details.message).toContain("died without completing");
  });
});

describe("render_episode tool double-start guard", () => {
  it("does not spawn a second render when one is already running with a live pid", async () => {
    // Our own pid is alive → the guard must short-circuit to the running job.
    writeJobStatus(scriptPath, JOB, { state: "running", pid: process.pid, startedAt: "t" });
    const res = await run(renderEpisodeTool, { scriptPath });
    expect(res.details.state).toBe("running");
    expect(res.details.pid).toBe(process.pid);
    expect(res.content[0].text).toContain("already running");
  });
});
