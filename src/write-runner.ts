#!/usr/bin/env tsx
/**
 * Detached runner for the Writer — the background half of the async `write_script`
 * transport (see src/job-status.ts for the why).
 *
 * The tool spawns this as a detached process and wires stdout+stderr to
 * `<dir>/write.log`. We take the write args as a single JSON argv value, mark the
 * sentinel `running`, run the unchanged Writer, write script.md, then record a
 * terminal `done` or `error` sentinel. A clean exit never leaves the sentinel stuck
 * at `running`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeScript } from "./agents/writer";
import { readJobStatus, writeJobStatus } from "./job-status";

const JOB = "write";

interface RunnerArgs {
  researchPath: string;
  outPath: string;
  album: string;
  artist: string;
  host: string;
  hostName: string;
  season: number;
  episode: number;
  model?: string;
  targetMinutes?: number;
  referenceTracks?: number;
  revisionNotes?: string;
}

function parseArgs(argv: string[]): RunnerArgs {
  const raw = argv[2];
  if (!raw) throw new Error("write-runner: missing JSON args (argv[2])");
  const a = JSON.parse(raw) as Partial<RunnerArgs>;
  if (
    !a.researchPath ||
    !a.outPath ||
    !a.album ||
    !a.artist ||
    !a.host ||
    !a.hostName ||
    a.season === undefined ||
    a.episode === undefined
  ) {
    throw new Error("write-runner: args must include researchPath, outPath, album, artist, host, hostName, season, episode");
  }
  return {
    researchPath: a.researchPath,
    outPath: a.outPath,
    album: a.album,
    artist: a.artist,
    host: a.host,
    hostName: a.hostName,
    season: a.season,
    episode: a.episode,
    model: a.model,
    targetMinutes: a.targetMinutes,
    referenceTracks: a.referenceTracks,
    revisionNotes: a.revisionNotes,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  mkdirSync(dirname(args.outPath), { recursive: true });

  const prev = readJobStatus(args.outPath, JOB);
  const startedAt = prev?.startedAt ?? new Date().toISOString();
  writeJobStatus(args.outPath, JOB, { state: "running", pid: process.pid, startedAt });

  try {
    const research = readFileSync(args.researchPath, "utf-8");
    const previousDraft =
      args.revisionNotes && existsSync(args.outPath) ? readFileSync(args.outPath, "utf-8") : undefined;
    const script = await writeScript({
      album: args.album,
      artist: args.artist,
      host: args.host,
      hostName: args.hostName,
      season: args.season,
      episode: args.episode,
      model: args.model,
      targetMinutes: args.targetMinutes,
      referenceTracks: args.referenceTracks,
      research,
      revisionNotes: args.revisionNotes,
      previousDraft,
    });
    writeFileSync(args.outPath, script, "utf-8");
    writeJobStatus(args.outPath, JOB, {
      state: "done",
      pid: process.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: { chars: script.length, revised: !!previousDraft },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[write-runner] failed: ${message}\n`);
    writeJobStatus(args.outPath, JOB, {
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
  process.stderr.write(`[write-runner] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
