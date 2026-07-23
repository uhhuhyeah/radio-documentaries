/**
 * Async transport for ANY long-running pipeline job: a status sentinel next to the
 * job's anchor file plus the poll-decision logic that drives a `wait_*` tool.
 *
 * This is the research transport (src/research-status.ts) with the one
 * research-specific thing — the hardcoded `research.status.json` / `research.log`
 * filenames — lifted out into a `job` name. Two jobs run this way now:
 *
 *   job "research", anchor <workdir>/research.md → research.status.json + research.log
 *   job "render",   anchor <workdir>/script.md   → render.status.json   + render.log
 *
 * Both exist for the same reason: the work (a ~10 min Researcher, a full-episode
 * ElevenLabs render) can outlast Hermes's 600s per-request MCP timeout, so the tool
 * spawns a detached runner and the caller polls until the job settles.
 *
 * The verdict is a pure function (`jobPollDecision`) and the sentinel
 * parse/serialize are pure too — unit-tested without spawning or the filesystem,
 * matching the pure/impure split in src/navidrome.ts (`scanPollDecision`). Only the
 * thin read/write/loop helpers touch I/O.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// wait_* defaults: these jobs run for many minutes, so a single wait call polls for
// a bounded 240s and reports `running` if it hasn't settled — the caller re-invokes.
// Poll every 5s (neither job is going to finish sub-second).
export const DEFAULT_JOB_TIMEOUT_MS = 240_000;
export const DEFAULT_JOB_INTERVAL_MS = 5_000;

/** Lifecycle of a background job, as recorded in `<job>.status.json`. */
export type JobState = "running" | "done" | "error";

/** The sentinel written next to the job's anchor file so the caller can poll it. */
export interface JobStatus {
  state: JobState;
  pid: number;
  startedAt: string; // ISO-ish timestamp (app code — Date.now()/toISOString is fine here)
  finishedAt?: string;
  /** Terminal payload the runner hands back (e.g. render's rendered/audioDir/cuePath). */
  result?: unknown;
  error?: string;
}

/**
 * What a `wait_*` poll should do next. Unlike scanPollDecision this carries both
 * terminal outcomes and the two "still running" cases:
 *  - `done`   — the runner wrote a terminal success; its output is ready.
 *  - `error`  — the runner wrote a terminal failure (its message rides in the status).
 *  - `stale`  — sentinel still says `running` but the pid is dead (the process died
 *               without writing a terminal state) → the caller treats it as an error.
 *  - `running`— the bounded timeout elapsed and the job is still alive. NOT an error:
 *               the caller should just call the wait tool again. (The deliberate
 *               departure from scanPollDecision, which returns `timeout` → throw.)
 *  - `wait`   — still running, time remains; keep polling within this call.
 */
export type JobPollVerdict = "done" | "error" | "stale" | "running" | "wait";

// --- pure helpers ------------------------------------------------------------

/** The sentinel path for a job anchored at `anchorPath`: `<dir>/<job>.status.json`. Pure. */
export function statusPathFor(anchorPath: string, job: string): string {
  return join(dirname(anchorPath), `${job}.status.json`);
}

/** The runner's log path for a job anchored at `anchorPath`: `<dir>/<job>.log`. Pure. */
export function logPathFor(anchorPath: string, job: string): string {
  return join(dirname(anchorPath), `${job}.log`);
}

/** Serialize a status to the sentinel's on-disk JSON. Pure. */
export function serializeStatus(status: JobStatus): string {
  return JSON.stringify(status, null, 2) + "\n";
}

/** Parse the sentinel's JSON back to a status. Pure; throws on malformed JSON. */
export function parseStatus(text: string, job = "job"): JobStatus {
  const raw = JSON.parse(text) as Partial<JobStatus>;
  if (raw.state !== "running" && raw.state !== "done" && raw.state !== "error") {
    throw new Error(`${job} status: bad state ${JSON.stringify(raw.state)}`);
  }
  return {
    state: raw.state,
    pid: Number(raw.pid ?? 0),
    startedAt: String(raw.startedAt ?? ""),
    ...(raw.finishedAt !== undefined ? { finishedAt: String(raw.finishedAt) } : {}),
    ...(raw.result !== undefined ? { result: raw.result } : {}),
    ...(raw.error !== undefined ? { error: String(raw.error) } : {}),
  };
}

/**
 * Decide what a poll should do next, given the latest sentinel, whether the runner
 * pid is still alive, and how long we've waited. Pure (no clock, no sleep, no I/O)
 * so it's unit-tested directly, mirroring scanPollDecision.
 *
 * Precedence is deliberate: a terminal state (done/error) wins over everything so
 * a job that settles exactly at the deadline still reports its real outcome; a dead
 * pid under a `running` sentinel is `stale` (an error) and wins over the timeout so
 * we never report "keep waiting" for a process that has actually died.
 */
export function jobPollDecision(
  status: JobStatus | null,
  pidAlive: boolean,
  elapsedMs: number,
  timeoutMs: number,
): JobPollVerdict {
  if (status?.state === "done") return "done";
  if (status?.state === "error") return "error";
  // From here the job is `running` (or the sentinel isn't there yet).
  if (status?.state === "running" && !pidAlive) return "stale";
  if (elapsedMs >= timeoutMs) return "running"; // bounded timeout, still alive — caller re-polls
  return "wait";
}

// --- thin I/O ----------------------------------------------------------------

/** Read + parse a job's sentinel; `null` if it doesn't exist yet. Throws only on malformed JSON. */
export function readJobStatus(anchorPath: string, job: string): JobStatus | null {
  const p = statusPathFor(anchorPath, job);
  if (!existsSync(p)) return null;
  return parseStatus(readFileSync(p, "utf-8"), job);
}

/** Write a job's sentinel next to its anchor (atomic enough for a single-writer runner). */
export function writeJobStatus(anchorPath: string, job: string, status: JobStatus): void {
  writeFileSync(statusPathFor(anchorPath, job), serializeStatus(status), "utf-8");
}

/** Is `pid` a live process? `process.kill(pid, 0)` probes without signalling. Thin I/O. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH → no such process; EPERM → it exists but we can't signal it (still alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface WaitJobOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/** The settled/timed-out verdict a `wait_*` tool hands back to the caller. */
export interface WaitJobResult {
  state: "done" | "error" | "running";
  status: JobStatus | null;
  message?: string; // set on error/stale — the reason to escalate with
}

/**
 * Poll a job's sentinel until it settles or the bounded timeout elapses. Only the
 * loop does I/O — the verdict is `jobPollDecision` and the sleep is kept out of that
 * pure helper, mirroring `waitForScan`. The KEY difference from `waitForScan`: a
 * bounded timeout is NOT an error here — we return `{ state: "running" }` and the
 * caller simply calls the wait tool again.
 */
export async function waitForJob(
  anchorPath: string,
  job: string,
  opts: WaitJobOptions = {},
): Promise<WaitJobResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_JOB_INTERVAL_MS;
  const start = Date.now();
  for (;;) {
    const status = readJobStatus(anchorPath, job);
    const alive = status ? isPidAlive(status.pid) : false;
    const verdict = jobPollDecision(status, alive, Date.now() - start, timeoutMs);
    if (verdict === "done") return { state: "done", status };
    if (verdict === "error") {
      return { state: "error", status, message: status?.error ?? `${job} failed` };
    }
    if (verdict === "stale") {
      return { state: "error", status, message: `${job} process died without completing` };
    }
    if (verdict === "running") return { state: "running", status };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
