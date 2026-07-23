#!/usr/bin/env tsx
/**
 * Detached runner for the ElevenLabs render — the background half of the async
 * `render_episode` transport (see src/job-status.ts for the why).
 *
 * `render_episode` spawns this as its own detached process (surviving the MCP tool
 * call returning) and wires our stdout+stderr to `<dir>/render.log` so a failure's
 * output is captured for debugging (the parent can't see it). We take the render
 * args as a single JSON argv value, mark the sentinel `running` (preserving the
 * parent's `startedAt`/`pid` if it already wrote one), run the UNCHANGED
 * `renderEpisode`, then write a terminal `done` (carrying the render result so
 * `wait_render` can report rendered/audioDir/cuePath) or `error` sentinel. A clean
 * exit never leaves the sentinel stuck at `running`.
 *
 * `renderEpisode` runs the credit hard-stop itself, so a refused render surfaces
 * here as a normal `error` sentinel with the guard's message — that is the intended
 * shape, not a lost failure.
 *
 * This is normal app code run via tsx/node (NOT a sandboxed workflow script), so
 * `new Date().toISOString()` for the timestamps is fine here.
 *
 *   tsx src/render-runner.ts '{"scriptPath":"…","force":false}'
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { readJobStatus, writeJobStatus } from "./job-status";
import { renderEpisode } from "./render";

/** The job name this runner's sentinel/log are keyed on: render.status.json / render.log. */
const JOB = "render";

interface RunnerArgs {
  scriptPath: string;
  /** RenderOptions.force — clean full re-render instead of resuming. Default off. */
  force?: boolean;
}

function parseArgs(argv: string[]): RunnerArgs {
  const raw = argv[2];
  if (!raw) throw new Error("render-runner: missing JSON args (argv[2])");
  const a = JSON.parse(raw) as Partial<RunnerArgs>;
  if (!a.scriptPath) throw new Error("render-runner: args must include scriptPath");
  return { scriptPath: a.scriptPath, force: a.force };
}

async function main(): Promise<void> {
  const { scriptPath, force } = parseArgs(process.argv);

  // Belt-and-suspenders: the parent (render_episode) already has the workdir (the
  // script lives in it), but ensure it exists so a direct runner invocation can't
  // ENOENT on the sentinel write.
  mkdirSync(dirname(scriptPath), { recursive: true });

  // Preserve the startedAt the parent stamped (so timing reflects the tool call),
  // and re-assert `running` with our pid — the parent recorded this same pid.
  const prev = readJobStatus(scriptPath, JOB);
  const startedAt = prev?.startedAt ?? new Date().toISOString();
  writeJobStatus(scriptPath, JOB, { state: "running", pid: process.pid, startedAt });

  try {
    const r = await renderEpisode(scriptPath, { force });
    writeJobStatus(scriptPath, JOB, {
      state: "done",
      pid: process.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      // The cue can be long; the caller only needs the headline outcome.
      result: {
        rendered: r.rendered,
        audioDir: r.audioDir,
        cuePath: r.cuePath,
        removed: r.removed,
        skipped: r.skipped,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[render-runner] failed: ${message}\n`);
    writeJobStatus(scriptPath, JOB, {
      state: "error",
      pid: process.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: message,
    });
    process.exitCode = 1;
  }
}

main().catch((e) => {
  // Last-resort guard: an error before we could parse scriptPath (no sentinel to
  // update). Surface it to the log and exit non-zero.
  process.stderr.write(`[render-runner] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
