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
 * The machinery itself now lives in src/job-status.ts, parameterised by a job name —
 * the render transport (src/render-runner.ts) is the second user. THIS module is the
 * research binding of it: `job = "research"`, anchor = the notes path. Its public API
 * is unchanged, so the research tools and tests are untouched by the extraction.
 */

import {
  DEFAULT_JOB_INTERVAL_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  type JobPollVerdict,
  jobPollDecision,
  type JobState,
  type JobStatus,
  logPathFor,
  parseStatus as parseJobStatus,
  readJobStatus,
  serializeStatus as serializeJobStatus,
  statusPathFor,
  waitForJob,
  type WaitJobOptions,
  type WaitJobResult,
  writeJobStatus,
} from "./job-status";

export { isPidAlive } from "./job-status";

/** The job name this module binds `job-status` to. */
const JOB = "research";

// wait_research defaults: research runs ~10 min, so a single wait_research call
// polls for a bounded 240s and reports `running` if it hasn't settled — the caller
// re-invokes. Poll every 5s (research isn't going to finish sub-second).
export const DEFAULT_RESEARCH_TIMEOUT_MS = DEFAULT_JOB_TIMEOUT_MS;
export const DEFAULT_RESEARCH_INTERVAL_MS = DEFAULT_JOB_INTERVAL_MS;

/** Lifecycle of a background research job, as recorded in `research.status.json`. */
export type ResearchState = JobState;

/** The sentinel written next to the notes so the caller can poll the job. */
export type ResearchStatus = JobStatus;

/** What a `wait_research` poll should do next — see `JobPollVerdict`. */
export type ResearchPollVerdict = JobPollVerdict;

// --- pure helpers ------------------------------------------------------------

/** The sentinel path for a given notes path: `<notesPath dir>/research.status.json`. Pure. */
export function statusPath(notesPath: string): string {
  return statusPathFor(notesPath, JOB);
}

/** The runner's log path for a given notes path: `<notesPath dir>/research.log`. Pure. */
export function logPath(notesPath: string): string {
  return logPathFor(notesPath, JOB);
}

/** Serialize a status to the sentinel's on-disk JSON. Pure. */
export function serializeStatus(status: ResearchStatus): string {
  return serializeJobStatus(status);
}

/** Parse the sentinel's JSON back to a status. Pure; throws on malformed JSON. */
export function parseStatus(text: string): ResearchStatus {
  return parseJobStatus(text, JOB);
}

/** Decide what a research poll should do next — see `jobPollDecision`. Pure. */
export function researchPollDecision(
  status: ResearchStatus | null,
  pidAlive: boolean,
  elapsedMs: number,
  timeoutMs: number,
): ResearchPollVerdict {
  return jobPollDecision(status, pidAlive, elapsedMs, timeoutMs);
}

// --- thin I/O ----------------------------------------------------------------

/** Read + parse the sentinel; `null` if it doesn't exist yet. Throws only on malformed JSON. */
export function readStatus(notesPath: string): ResearchStatus | null {
  return readJobStatus(notesPath, JOB);
}

/** Write the sentinel next to the notes (atomic enough for a single-writer runner). */
export function writeStatus(notesPath: string, status: ResearchStatus): void {
  writeJobStatus(notesPath, JOB, status);
}

export type WaitResearchOptions = WaitJobOptions;

/** The settled/timed-out verdict `wait_research` hands back to the caller. */
export type WaitResearchResult = WaitJobResult;

/**
 * Poll the sentinel until the job settles or the bounded timeout elapses. A bounded
 * timeout is NOT an error: we return `{ state: "running" }` and the caller simply
 * calls `wait_research` again. See `waitForJob`.
 */
export async function waitResearch(
  notesPath: string,
  opts: WaitResearchOptions = {},
): Promise<WaitResearchResult> {
  return waitForJob(notesPath, JOB, opts);
}
