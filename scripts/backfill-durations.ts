#!/usr/bin/env tsx
/**
 * Backfill `durationSec` + `totals` into rundown.json files produced before the
 * render step started measuring them.
 *
 *   pnpm tsx scripts/backfill-durations.ts S01E01-punisher/rundown.json
 *   pnpm tsx scripts/backfill-durations.ts --dry-run S01E0*\/rundown.json
 *
 * Uses the same `withDurations`/`cueTotals` the renderer does, so a backfilled
 * rundown is byte-identical to one a fresh render would write. Audio is located
 * via the rundown's own `audioDir`, falling back to `audio/` next to the file.
 *
 * Needs ffprobe on PATH and the episode's MP3s on disk. Segments that can't be
 * measured are left without a duration and reported, rather than guessed at.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { type CueEntry, cueTotals, withDurations } from "../src/render";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const paths = args.filter((a) => !a.startsWith("--"));

if (paths.length === 0) {
  console.error("usage: backfill-durations.ts [--dry-run] <rundown.json> [...]");
  process.exit(2);
}

const fmt = (sec: number): string => `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, "0")}s`;

let failed = 0;

for (const path of paths) {
  if (!existsSync(path)) {
    console.error(`✗ ${path}: not found`);
    failed++;
    continue;
  }

  const rundown = JSON.parse(readFileSync(path, "utf-8")) as {
    audioDir?: string;
    cue: CueEntry[];
    [key: string]: unknown;
  };

  // `audioDir` is recorded by whichever machine rendered the episode, and how
  // it's written has varied: absolute on one host, relative-to-repo-root on
  // another. Try each reading, then fall back to `audio/` beside the rundown.
  const recorded = rundown.audioDir;
  const candidates = [
    ...(recorded ? (isAbsolute(recorded) ? [recorded] : [recorded, join(dirname(path), recorded)]) : []),
    join(dirname(path), "audio"),
  ];
  const audioDir = candidates.find((dir) => existsSync(dir));

  if (!audioDir) {
    console.error(`✗ ${path}: no audio directory (tried ${candidates.join(", ")})`);
    failed++;
    continue;
  }

  const cue = withDurations(rundown.cue, audioDir);
  const totals = cueTotals(cue);

  const missing = cue.filter((c) => c.kind === "SPOKEN" && c.durationSec === undefined);
  for (const m of missing) console.error(`  ! ${path}: could not measure ${m.file}`);

  // Key order matches what the renderer writes, so backfilled and freshly
  // rendered files diff cleanly against each other.
  const { season, episode, album, audioDir: _drop, cue: _cue, totals: _totals, ...rest } = rundown;
  const next = { season, episode, album, audioDir, totals, cue, ...rest };

  if (!dryRun) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);

  const flag = totals.complete ? "" : " (INCOMPLETE)";
  console.log(
    `${dryRun ? "would write" : "wrote"} ${path}: ${totals.spokenSegments} spoken, ${fmt(totals.spokenSec)}${flag}`,
  );
}

process.exit(failed > 0 ? 1 : 0);
