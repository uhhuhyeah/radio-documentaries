import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeStatus } from "../research-status";
import { researchAlbumTool, researchStatusTool, waitResearchTool } from "./subagents";

// The execute signature is (toolCallId, params, signal, onUpdate, ctx); the wrappers
// ignore the trailing three — a loose call keeps the tests focused on behaviour.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: any, params: any): Promise<any> => tool.execute("test-call", params, undefined, undefined, {});

let dir: string;
let notesPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "research-"));
  notesPath = join(dir, "research.md");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("research_status tool", () => {
  it("reports 'missing' when no job has been started", async () => {
    const res = await run(researchStatusTool, { notesPath });
    expect(res.details.state).toBe("missing");
  });

  it("reflects the current sentinel state", async () => {
    writeStatus(notesPath, { state: "done", pid: 123, startedAt: "t", finishedAt: "t2" });
    const res = await run(researchStatusTool, { notesPath });
    expect(res.details.state).toBe("done");
    expect(res.details.status.finishedAt).toBe("t2");
  });
});

describe("wait_research tool", () => {
  it("returns done immediately when the sentinel is already done", async () => {
    writeStatus(notesPath, { state: "done", pid: 123, startedAt: "t", finishedAt: "t2" });
    const res = await run(waitResearchTool, { notesPath, timeoutSec: 1, intervalSec: 1 });
    expect(res.details.state).toBe("done");
  });

  it("returns error with the sentinel's message when the job failed", async () => {
    writeStatus(notesPath, { state: "error", pid: 123, startedAt: "t", error: "no search results" });
    const res = await run(waitResearchTool, { notesPath, timeoutSec: 1, intervalSec: 1 });
    expect(res.details.state).toBe("error");
    expect(res.details.message).toContain("no search results");
  });

  it("returns error (stale) when the sentinel says running but the pid is dead", async () => {
    // pid 2^31-1 is effectively never a live process.
    writeStatus(notesPath, { state: "running", pid: 2_147_483_646, startedAt: "t" });
    const res = await run(waitResearchTool, { notesPath, timeoutSec: 5, intervalSec: 1 });
    expect(res.details.state).toBe("error");
    expect(res.details.message).toContain("died without completing");
  });
});

describe("research_album tool double-start guard", () => {
  it("does not spawn a second job when one is already running with a live pid", async () => {
    // Our own pid is alive → the guard must short-circuit to the running job.
    writeStatus(notesPath, { state: "running", pid: process.pid, startedAt: "t" });
    const res = await run(researchAlbumTool, { album: "A", artist: "B", notesPath });
    expect(res.details.state).toBe("running");
    expect(res.content[0].text).toContain("already running");
  });
});
