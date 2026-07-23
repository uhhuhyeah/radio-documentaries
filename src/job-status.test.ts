import { describe, expect, it } from "vitest";

import {
  type JobStatus,
  jobPollDecision,
  logPathFor,
  parseStatus,
  serializeStatus,
  statusPathFor,
} from "./job-status";

describe("statusPathFor / logPathFor", () => {
  it("names the sentinel and log after the job, next to the anchor file", () => {
    expect(statusPathFor("/work/S01E01-punisher/research.md", "research")).toBe(
      "/work/S01E01-punisher/research.status.json",
    );
    expect(logPathFor("/work/S01E01-punisher/research.md", "research")).toBe(
      "/work/S01E01-punisher/research.log",
    );
    expect(statusPathFor("/work/S01E01-punisher/script.md", "render")).toBe(
      "/work/S01E01-punisher/render.status.json",
    );
    expect(logPathFor("/work/S01E01-punisher/script.md", "render")).toBe("/work/S01E01-punisher/render.log");
  });

  it("keeps two jobs in the same workdir apart", () => {
    const dir = "/work/S01E01-punisher";
    expect(statusPathFor(`${dir}/research.md`, "research")).not.toBe(statusPathFor(`${dir}/script.md`, "render"));
  });
});

describe("serializeStatus / parseStatus", () => {
  it("round-trips a running status", () => {
    const s: JobStatus = { state: "running", pid: 4242, startedAt: "2026-07-22T09:00:00.000Z" };
    expect(parseStatus(serializeStatus(s))).toEqual(s);
  });

  it("round-trips a done status with finishedAt and a job result", () => {
    const s: JobStatus = {
      state: "done",
      pid: 4242,
      startedAt: "2026-07-22T09:00:00.000Z",
      finishedAt: "2026-07-22T09:10:00.000Z",
      result: { rendered: 12, audioDir: "/work/S01E01-punisher/audio", cuePath: "/work/S01E01-punisher/rundown.json" },
    };
    expect(parseStatus(serializeStatus(s))).toEqual(s);
  });

  it("round-trips an error status with a message", () => {
    const s: JobStatus = {
      state: "error",
      pid: 4242,
      startedAt: "2026-07-22T09:00:00.000Z",
      finishedAt: "2026-07-22T09:02:00.000Z",
      error: "credit guard: balance too low to finish this episode",
    };
    expect(parseStatus(serializeStatus(s))).toEqual(s);
  });

  it("omits absent optional fields rather than emitting undefined", () => {
    const parsed = parseStatus(serializeStatus({ state: "running", pid: 1, startedAt: "t" }));
    expect("finishedAt" in parsed).toBe(false);
    expect("result" in parsed).toBe(false);
    expect("error" in parsed).toBe(false);
  });

  it("rejects an unknown state, naming the job in the message", () => {
    expect(() => parseStatus(JSON.stringify({ state: "weird", pid: 1, startedAt: "t" }), "render")).toThrow(
      /render status: bad state/,
    );
  });
});

describe("jobPollDecision", () => {
  const TIMEOUT = 240_000;
  const running: JobStatus = { state: "running", pid: 4242, startedAt: "t" };

  it("waits while the job is running, its pid is alive, and time remains", () => {
    expect(jobPollDecision(running, true, 10_000, TIMEOUT)).toBe("wait");
  });

  it("is done once the sentinel reports done", () => {
    const done: JobStatus = { state: "done", pid: 4242, startedAt: "t", finishedAt: "t2" };
    expect(jobPollDecision(done, false, 10_000, TIMEOUT)).toBe("done");
  });

  it("is error once the sentinel reports error", () => {
    const err: JobStatus = { state: "error", pid: 4242, startedAt: "t", error: "boom" };
    expect(jobPollDecision(err, false, 10_000, TIMEOUT)).toBe("error");
  });

  it("is stale when the sentinel says running but the pid is dead", () => {
    expect(jobPollDecision(running, false, 10_000, TIMEOUT)).toBe("stale");
  });

  it("returns running (NOT timeout/error) when the bounded timeout is hit and the job is still alive", () => {
    // The deliberate departure from scanPollDecision: a bounded timeout is not an error.
    expect(jobPollDecision(running, true, TIMEOUT, TIMEOUT)).toBe("running");
    expect(jobPollDecision(running, true, TIMEOUT + 5_000, TIMEOUT)).toBe("running");
  });

  it("waits just below the timeout boundary", () => {
    expect(jobPollDecision(running, true, TIMEOUT - 1, TIMEOUT)).toBe("wait");
  });

  it("done wins over the timeout when a job settles past the deadline", () => {
    const done: JobStatus = { state: "done", pid: 4242, startedAt: "t", finishedAt: "t2" };
    expect(jobPollDecision(done, false, TIMEOUT + 5_000, TIMEOUT)).toBe("done");
  });

  it("error wins over the timeout too", () => {
    const err: JobStatus = { state: "error", pid: 4242, startedAt: "t", error: "boom" };
    expect(jobPollDecision(err, true, TIMEOUT + 5_000, TIMEOUT)).toBe("error");
  });

  it("stale wins over the timeout — a dead process is an error, not 'keep waiting'", () => {
    expect(jobPollDecision(running, false, TIMEOUT + 5_000, TIMEOUT)).toBe("stale");
  });

  it("waits when the sentinel isn't written yet and time remains", () => {
    expect(jobPollDecision(null, false, 1_000, TIMEOUT)).toBe("wait");
  });

  it("reports running when the sentinel is still missing at the deadline", () => {
    // No sentinel yet is not a death sentence — the caller re-polls.
    expect(jobPollDecision(null, false, TIMEOUT, TIMEOUT)).toBe("running");
  });
});
