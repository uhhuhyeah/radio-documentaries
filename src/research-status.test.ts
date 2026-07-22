import { describe, expect, it } from "vitest";

import {
  logPath,
  parseStatus,
  type ResearchStatus,
  researchPollDecision,
  serializeStatus,
  statusPath,
} from "./research-status";

describe("statusPath / logPath", () => {
  it("puts the sentinel and log next to the notes", () => {
    expect(statusPath("/work/S01E01-punisher/research.md")).toBe(
      "/work/S01E01-punisher/research.status.json",
    );
    expect(logPath("/work/S01E01-punisher/research.md")).toBe("/work/S01E01-punisher/research.log");
  });
});

describe("serializeStatus / parseStatus", () => {
  it("round-trips a running status", () => {
    const s: ResearchStatus = { state: "running", pid: 4242, startedAt: "2026-07-22T09:00:00.000Z" };
    expect(parseStatus(serializeStatus(s))).toEqual(s);
  });

  it("round-trips a done status with finishedAt", () => {
    const s: ResearchStatus = {
      state: "done",
      pid: 4242,
      startedAt: "2026-07-22T09:00:00.000Z",
      finishedAt: "2026-07-22T09:10:00.000Z",
    };
    expect(parseStatus(serializeStatus(s))).toEqual(s);
  });

  it("round-trips an error status with a message", () => {
    const s: ResearchStatus = {
      state: "error",
      pid: 4242,
      startedAt: "2026-07-22T09:00:00.000Z",
      finishedAt: "2026-07-22T09:02:00.000Z",
      error: "researcher found no search results",
    };
    expect(parseStatus(serializeStatus(s))).toEqual(s);
  });

  it("omits absent optional fields rather than emitting undefined", () => {
    const parsed = parseStatus(serializeStatus({ state: "running", pid: 1, startedAt: "t" }));
    expect("finishedAt" in parsed).toBe(false);
    expect("error" in parsed).toBe(false);
  });

  it("rejects an unknown state", () => {
    expect(() => parseStatus(JSON.stringify({ state: "weird", pid: 1, startedAt: "t" }))).toThrow(/bad state/);
  });
});

describe("researchPollDecision", () => {
  const TIMEOUT = 240_000;
  const running: ResearchStatus = { state: "running", pid: 4242, startedAt: "t" };

  it("waits while the job is running, its pid is alive, and time remains", () => {
    expect(researchPollDecision(running, true, 10_000, TIMEOUT)).toBe("wait");
  });

  it("is done once the sentinel reports done", () => {
    const done: ResearchStatus = { state: "done", pid: 4242, startedAt: "t", finishedAt: "t2" };
    expect(researchPollDecision(done, false, 10_000, TIMEOUT)).toBe("done");
  });

  it("is error once the sentinel reports error", () => {
    const err: ResearchStatus = { state: "error", pid: 4242, startedAt: "t", error: "boom" };
    expect(researchPollDecision(err, false, 10_000, TIMEOUT)).toBe("error");
  });

  it("is stale when the sentinel says running but the pid is dead", () => {
    expect(researchPollDecision(running, false, 10_000, TIMEOUT)).toBe("stale");
  });

  it("returns running (NOT timeout/error) when the bounded timeout is hit and the job is still alive", () => {
    // The deliberate departure from scanPollDecision: a bounded timeout is not an error.
    expect(researchPollDecision(running, true, TIMEOUT, TIMEOUT)).toBe("running");
    expect(researchPollDecision(running, true, TIMEOUT + 5_000, TIMEOUT)).toBe("running");
  });

  it("waits just below the timeout boundary", () => {
    expect(researchPollDecision(running, true, TIMEOUT - 1, TIMEOUT)).toBe("wait");
  });

  it("done wins over the timeout when a job settles past the deadline", () => {
    const done: ResearchStatus = { state: "done", pid: 4242, startedAt: "t", finishedAt: "t2" };
    expect(researchPollDecision(done, false, TIMEOUT + 5_000, TIMEOUT)).toBe("done");
  });

  it("stale wins over the timeout — a dead process is an error, not 'keep waiting'", () => {
    expect(researchPollDecision(running, false, TIMEOUT + 5_000, TIMEOUT)).toBe("stale");
  });

  it("waits when the sentinel isn't written yet and time remains", () => {
    expect(researchPollDecision(null, false, 1_000, TIMEOUT)).toBe("wait");
  });
});
