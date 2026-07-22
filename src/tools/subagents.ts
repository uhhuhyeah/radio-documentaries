/**
 * Sub-agents exposed to the Producer as tools (the "agent-as-tool" pattern).
 * The Producer calls research_album then write_script; each runs a sub-agent and
 * leaves its output as a file in the working directory.
 *
 * Research is the long one (~10 min) — longer than Hermes's 600s per-request MCP
 * timeout — so it runs ASYNC: `research_album` spawns a detached runner and returns
 * immediately; the caller polls `wait_research` until the job settles (see
 * src/research-status.ts). `write_script` is still synchronous.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";

import { defineTool } from "@earendil-works/pi-coding-agent";

import { writeScript } from "../agents/writer";
import {
  DEFAULT_RESEARCH_INTERVAL_MS,
  DEFAULT_RESEARCH_TIMEOUT_MS,
  isPidAlive,
  logPath,
  readStatus,
  waitResearch,
  writeStatus,
} from "../research-status";
import { toolResult } from "./util";

// Repo root: src/tools/subagents.ts → ../.. — the cwd the detached runner is
// spawned from (so `pnpm exec tsx src/research-runner.ts` resolves).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const researchAlbumTool = defineTool({
  name: "research_album",
  label: "Research album",
  description:
    "Start the Researcher sub-agent to web-research an album's making-of and write organised notes to " +
    "notesPath. Non-blocking: research takes ~10 min, so this spawns a detached background job and " +
    "returns immediately with state 'started'. Poll wait_research(notesPath) until it reports 'done' " +
    "before write_script; on 'error', stop and report. Re-calling while a job is already running is a " +
    "no-op (returns the running job).",
  parameters: Type.Object({
    album: Type.String(),
    artist: Type.String(),
    notesPath: Type.String({ description: "Where to write the notes, e.g. <workdir>/research.md" }),
    focus: Type.Optional(Type.String()),
  }),
  execute: async (_id, p) => {
    const workdir = dirname(p.notesPath);

    // Own the filesystem: create the working dir so the runner's log/sentinel/notes writes
    // land (a remote orchestrator has no filesystem here and shouldn't mkdir). This is why
    // notesPath must be the ABSOLUTE workdir path catalog_assign returns, not an invented one.
    mkdirSync(workdir, { recursive: true });

    // Guard against a double-start: if a job is already running with a live pid,
    // return it rather than spawning a second Researcher over the same notes.
    const existing = readStatus(p.notesPath);
    if (existing?.state === "running" && isPidAlive(existing.pid)) {
      return toolResult(`research already running (pid ${existing.pid}) → ${p.notesPath}`, {
        notesPath: p.notesPath,
        workdir,
        state: "running",
      });
    }

    // Spawn the runner detached so it survives this tool call returning. Its
    // stdout+stderr (the researcher's progress notes) go to <dir>/research.log —
    // stdio:"ignore" would lose them, so we wire the log fd instead.
    const log = openSync(logPath(p.notesPath), "a");
    const argsJson = JSON.stringify({ album: p.album, artist: p.artist, notesPath: p.notesPath, focus: p.focus });
    const child = spawn("pnpm", ["exec", "tsx", "src/research-runner.ts", argsJson], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", log, log],
    });
    // A failed spawn (ENOENT/EAGAIN) emits 'error' asynchronously; an unhandled
    // 'error' event would throw and crash the long-lived MCP server. Catch it and
    // record a terminal error sentinel so wait_research reports it instead.
    child.on("error", (err) => {
      writeStatus(p.notesPath, {
        state: "error",
        pid: child.pid ?? -1,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: `failed to spawn research runner: ${err.message}`,
      });
    });
    child.unref();
    closeSync(log); // the child dup'd its own fd; don't leak the parent's copy per call.

    // Write the sentinel in the PARENT before returning so an immediate
    // wait_research never races a missing file (the runner re-asserts it too).
    const pid = child.pid ?? -1;
    writeStatus(p.notesPath, { state: "running", pid, startedAt: new Date().toISOString() });

    return toolResult(`research started (pid ${pid}) → ${p.notesPath}; poll wait_research`, {
      notesPath: p.notesPath,
      workdir,
      state: "started",
      pid,
    });
  },
});

export const waitResearchTool = defineTool({
  name: "wait_research",
  label: "Wait for research",
  description:
    "Poll a research_album job until it settles or a bounded timeout elapses. Returns state 'done' " +
    "(notes ready — proceed to write_script), 'error' (halt and escalate with message), or 'running' " +
    "(the bounded timeout was hit and the job is STILL going — this is NOT an error: just call " +
    "wait_research again). A job whose process died without finishing is reported as 'error'. Defaults: " +
    "timeout 240s, poll every 5s.",
  parameters: Type.Object({
    notesPath: Type.String({ description: "The research_album notesPath whose job to wait on." }),
    timeoutSec: Type.Optional(
      Type.Number({ description: "Max seconds to poll before returning 'running' (default 240)." }),
    ),
    intervalSec: Type.Optional(Type.Number({ description: "Seconds between status polls (default 5)." })),
  }),
  execute: async (_id, p) => {
    const r = await waitResearch(p.notesPath, {
      timeoutMs: p.timeoutSec !== undefined ? p.timeoutSec * 1000 : DEFAULT_RESEARCH_TIMEOUT_MS,
      intervalMs: p.intervalSec !== undefined ? p.intervalSec * 1000 : DEFAULT_RESEARCH_INTERVAL_MS,
    });
    const summary =
      r.state === "done"
        ? `research done → ${p.notesPath}`
        : r.state === "error"
          ? `research error: ${r.message}`
          : `research still running (timeout hit; call wait_research again) → ${p.notesPath}`;
    return toolResult(summary, { notesPath: p.notesPath, state: r.state, message: r.message, status: r.status });
  },
});

export const researchStatusTool = defineTool({
  name: "research_status",
  label: "Research status",
  description:
    "Instant, non-blocking single read of a research_album job's status sentinel. Returns the current " +
    "state ('running' | 'done' | 'error', or 'missing' if no job has been started for that notesPath). " +
    "Use wait_research to actually block until it settles.",
  parameters: Type.Object({
    notesPath: Type.String({ description: "The research_album notesPath whose status to read." }),
  }),
  execute: async (_id, p) => {
    const status = readStatus(p.notesPath);
    const state = status?.state ?? "missing";
    return toolResult(`research status: ${state} → ${p.notesPath}`, { notesPath: p.notesPath, state, status });
  },
});

export const writeScriptTool = defineTool({
  name: "write_script",
  label: "Write script",
  description:
    "Run the Writer sub-agent to turn research notes into a format-compliant script.md. " +
    "Uses ONLY the notes (no web). Lint the result afterwards. To REVISE after a review, pass " +
    "revisionNotes (the lint/QA/factcheck fixes to make): the Writer then revises the existing " +
    "script.md at outPath to address them instead of regenerating — so the rewrite loop converges.",
  parameters: Type.Object({
    researchPath: Type.String(),
    outPath: Type.String({ description: "Where to write script.md" }),
    album: Type.String(),
    artist: Type.String(),
    host: Type.String({ description: "Persona id, e.g. p_jools" }),
    hostName: Type.String({ description: "Cara | Jools" }),
    season: Type.Integer(),
    episode: Type.Integer(),
    model: Type.Optional(Type.String()),
    targetMinutes: Type.Optional(Type.Integer()),
    referenceTracks: Type.Optional(Type.Integer()),
    revisionNotes: Type.Optional(
      Type.String({
        description:
          "Targeted fixes from a review pass (e.g. 'quote lyric X verbatim; cut the invented Y claim; " +
          "deepen to ~25 min'). Revises the existing script.md at outPath instead of regenerating.",
      }),
    ),
  }),
  execute: async (_id, p) => {
    const research = readFileSync(p.researchPath, "utf-8");
    // Revise mode: notes + an existing draft at outPath. If notes are given but no draft exists,
    // fall through to a fresh write (nothing to revise).
    const previousDraft =
      p.revisionNotes && existsSync(p.outPath) ? readFileSync(p.outPath, "utf-8") : undefined;
    const script = await writeScript({
      album: p.album,
      artist: p.artist,
      host: p.host,
      hostName: p.hostName,
      season: p.season,
      episode: p.episode,
      model: p.model,
      targetMinutes: p.targetMinutes,
      referenceTracks: p.referenceTracks,
      research,
      revisionNotes: p.revisionNotes,
      previousDraft,
    });
    mkdirSync(dirname(p.outPath), { recursive: true });
    writeFileSync(p.outPath, script, "utf-8");
    const mode = previousDraft ? "revised" : "wrote";
    return toolResult(`${mode} script → ${p.outPath} (${script.length} chars)`, {
      outPath: p.outPath,
      revised: !!previousDraft,
    });
  },
});
