#!/usr/bin/env tsx
/**
 * Detached runner for the Researcher — the background half of the async
 * `research_album` transport (see src/research-status.ts for the why).
 *
 * `research_album` spawns this as its own detached process (surviving the MCP tool
 * call returning) and wires our stdout+stderr to `<dir>/research.log` so the
 * researcher's progress notes are captured for debugging (the parent can't see
 * them). We take the research args as a single JSON argv value, mark the sentinel
 * `running` (preserving the parent's `startedAt`/`pid` if it already wrote one),
 * run the UNCHANGED `researchAlbum`, then write a terminal `done` or `error`
 * sentinel. A clean exit never leaves the sentinel stuck at `running`.
 *
 * This is normal app code run via tsx/node (NOT a sandboxed workflow script), so
 * `new Date().toISOString()` for the timestamps is fine here.
 *
 *   tsx src/research-runner.ts '{"album":"…","artist":"…","notesPath":"…","focus":"…"}'
 */

import { researchAlbum } from "./agents/researcher";
import { readStatus, writeStatus } from "./research-status";

interface RunnerArgs {
  album: string;
  artist: string;
  notesPath: string;
  focus?: string;
}

function parseArgs(argv: string[]): RunnerArgs {
  const raw = argv[2];
  if (!raw) throw new Error("research-runner: missing JSON args (argv[2])");
  const a = JSON.parse(raw) as Partial<RunnerArgs>;
  if (!a.album || !a.artist || !a.notesPath) {
    throw new Error("research-runner: args must include album, artist, notesPath");
  }
  return { album: a.album, artist: a.artist, notesPath: a.notesPath, focus: a.focus };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const { notesPath } = args;

  // Preserve the startedAt the parent stamped (so timing reflects the tool call),
  // and re-assert `running` with our pid — the parent recorded this same pid.
  const prev = readStatus(notesPath);
  const startedAt = prev?.startedAt ?? new Date().toISOString();
  writeStatus(notesPath, { state: "running", pid: process.pid, startedAt });

  try {
    await researchAlbum(args.album, args.artist, args.notesPath, args.focus);
    writeStatus(notesPath, {
      state: "done",
      pid: process.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[research-runner] failed: ${message}\n`);
    writeStatus(notesPath, {
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
  // Last-resort guard: an error before we could parse notesPath (no sentinel to
  // update). Surface it to the log and exit non-zero.
  process.stderr.write(`[research-runner] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
