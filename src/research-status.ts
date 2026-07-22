/**
 * Async transport for the long-running Researcher: a status sentinel next to the
 * notes plus the poll-decision logic that drives `wait_research`.
 *
 * The Researcher itself (src/agents/researcher.ts) is unchanged and takes ~10 min —
 * longer than Hermes's 600s per-request MCP timeout. So `research_album` no longer
 * `await`s it: it spawns a detached runner (src/research-runner.ts) that writes a
 * `research.status.json` sentinel, and the caller polls `wait_research` until the
 * job settles. This mirrors the navidrome wait_scan pattern, with ONE deliberate
 * difference: on a bounded timeout `wait_research` returns `running` (caller just
 * polls again) rather than throwing like `waitForScan` does.
 *
 * The verdict is a pure function (`researchPollDecision`) and the sentinel
 * parse/serialize are pure too — unit-tested without spawning or the filesystem,
 * matching the pure/impure split in src/navidrome.ts (`scanPollDecision`). Only the
 * thin read/write/loop helpers touch I/O.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// wait_research defaults: research runs ~10 min, so a single wait_research call
// polls for a bounded 240s and reports `running` if it hasn't settled — the caller
// re-invokes. Poll every 5s (research isn't going to finish sub-second).
export const DEFAULT_RESEARCH_TIMEOUT_MS = 240_000;
export const DEFAULT_RESEARCH_INTERVAL_MS = 5_000;

/** Lifecycle of a background research job, as recorded in `research.status.json`. */
export type ResearchState = "running" | "done" | "error";

/** The sentinel written next to the notes so the caller can poll the job. */
export interface ResearchStatus {
  state: ResearchState;
  pid: number;
  startedAt: string; // ISO-ish timestamp (app code — Date.now()/toISOString is fine here)
  finishedAt?: string;
  error?: string;
}

/**
 * What a `wait_research` poll should do next. Unlike scanPollDecision this carries
 * both terminal outcomes and the two "still running" cases:
 *  - `done`   — the runner wrote a terminal success; notes are ready.
 *  - `error`  — the runner wrote a terminal failure (its message rides in the status).
 *  - `stale`  — sentinel still says `running` but the pid is dead (the process died
 *               without writing a terminal state) → the caller treats it as an error.
 *  - `running`— the bounded timeout elapsed and the job is still alive. NOT an error:
 *               the caller should just call `wait_research` again. (The deliberate
 *               departure from scanPollDecision, which returns `timeout` → throw.)
 *  - `wait`   — still running, time remains; keep polling within this call.
 */
export type ResearchPollVerdict = "done" | "error" | "stale" | "running" | "wait";

// --- pure helpers ------------------------------------------------------------

/** The sentinel path for a given notes path: `<notesPath dir>/research.status.json`. Pure. */
export function statusPath(notesPath: string): string {
  return join(dirname(notesPath), "research.status.json");
}

/** The runner's log path for a given notes path: `<notesPath dir>/research.log`. Pure. */
export function logPath(notesPath: string): string {
  return join(dirname(notesPath), "research.log");
}

/** Serialize a status to the sentinel's on-disk JSON. Pure. */
export function serializeStatus(status: ResearchStatus): string {
  return JSON.stringify(status, null, 2) + "\n";
}

/** Parse the sentinel's JSON back to a status. Pure; throws on malformed JSON. */
export function parseStatus(text: string): ResearchStatus {
  const raw = JSON.parse(text) as Partial<ResearchStatus>;
  if (raw.state !== "running" && raw.state !== "done" && raw.state !== "error") {
    throw new Error(`research status: bad state ${JSON.stringify(raw.state)}`);
  }
  return {
    state: raw.state,
    pid: Number(raw.pid ?? 0),
    startedAt: String(raw.startedAt ?? ""),
    ...(raw.finishedAt !== undefined ? { finishedAt: String(raw.finishedAt) } : {}),
    ...(raw.error !== undefined ? { error: String(raw.error) } : {}),
  };
}

/**
 * Decide what a research poll should do next, given the latest sentinel, whether
 * the runner pid is still alive, and how long we've waited. Pure (no clock, no
 * sleep, no I/O) so it's unit-tested directly, mirroring scanPollDecision.
 *
 * Precedence is deliberate: a terminal state (done/error) wins over everything so
 * a job that settles exactly at the deadline still reports its real outcome; a dead
 * pid under a `running` sentinel is `stale` (an error) and wins over the timeout so
 * we never report "keep waiting" for a process that has actually died.
 */
export function researchPollDecision(
  status: ResearchStatus | null,
  pidAlive: boolean,
  elapsedMs: number,
  timeoutMs: number,
): ResearchPollVerdict {
  if (status?.state === "done") return "done";
  if (status?.state === "error") return "error";
  // From here the job is `running` (or the sentinel isn't there yet).
  if (status?.state === "running" && !pidAlive) return "stale";
  if (elapsedMs >= timeoutMs) return "running"; // bounded timeout, still alive — caller re-polls
  return "wait";
}

// --- thin I/O ----------------------------------------------------------------

/** Read + parse the sentinel; `null` if it doesn't exist yet. Throws only on malformed JSON. */
export function readStatus(notesPath: string): ResearchStatus | null {
  const p = statusPath(notesPath);
  if (!existsSync(p)) return null;
  return parseStatus(readFileSync(p, "utf-8"));
}

/** Write the sentinel next to the notes (atomic enough for a single-writer runner). */
export function writeStatus(notesPath: string, status: ResearchStatus): void {
  writeFileSync(statusPath(notesPath), serializeStatus(status), "utf-8");
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

export interface WaitResearchOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/** The settled/timed-out verdict `wait_research` hands back to the caller. */
export interface WaitResearchResult {
  state: "done" | "error" | "running";
  status: ResearchStatus | null;
  message?: string; // set on error/stale — the reason to escalate with
}

/**
 * Poll the sentinel until the job settles or the bounded timeout elapses. Only the
 * loop does I/O — the verdict is `researchPollDecision` and the sleep is kept out of
 * that pure helper, mirroring `waitForScan`. The KEY difference from `waitForScan`:
 * a bounded timeout is NOT an error here — we return `{ state: "running" }` and the
 * caller simply calls `wait_research` again.
 */
export async function waitResearch(
  notesPath: string,
  opts: WaitResearchOptions = {},
): Promise<WaitResearchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_RESEARCH_INTERVAL_MS;
  const start = Date.now();
  for (;;) {
    const status = readStatus(notesPath);
    const alive = status ? isPidAlive(status.pid) : false;
    const verdict = researchPollDecision(status, alive, Date.now() - start, timeoutMs);
    if (verdict === "done") return { state: "done", status };
    if (verdict === "error") {
      return { state: "error", status, message: status?.error ?? "research failed" };
    }
    if (verdict === "stale") {
      return { state: "error", status, message: "research process died without completing" };
    }
    if (verdict === "running") return { state: "running", status };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
