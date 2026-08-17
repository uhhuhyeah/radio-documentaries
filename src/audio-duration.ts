/**
 * Measured audio durations, via ffprobe.
 *
 * The cue sheet is planned before anything is rendered, so it can only ever
 * know filenames. The *lengths* have to be measured off the finished MP3s, and
 * ffprobe is already a hard dependency of the compile-episode step.
 *
 * Two flavours on purpose:
 *   - `probeDurationSec` throws, for callers that genuinely cannot proceed
 *     without a real number (chapter offsets, concat validation).
 *   - `tryProbeDurationSec` returns undefined, for callers where a duration is
 *     a nice-to-have. Rendering an episode costs real money; a missing ffprobe
 *     must never be the reason a paid render fails at the final write.
 *
 * (`compiled-episodes.ts` predates this module and keeps its own private copy
 * of the throwing variant. Worth collapsing into this one, but not as a
 * drive-by on a tested path.)
 */
import { execFileSync } from "node:child_process";

export function parseFfprobeDuration(stdout: string): number {
  const n = Number(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`ffprobe returned invalid duration: ${stdout.trim()}`);
  return n;
}

/** Duration in seconds. Throws if ffprobe is missing or the file is unreadable. */
export function probeDurationSec(path: string): number {
  const stdout = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
    { encoding: "utf-8" },
  );
  return parseFfprobeDuration(stdout);
}

/** Duration in seconds, or undefined if it can't be measured. Never throws. */
export function tryProbeDurationSec(path: string): number | undefined {
  try {
    return probeDurationSec(path);
  } catch {
    return undefined;
  }
}

/** Round to centiseconds — plenty for a running time, and keeps the JSON tidy. */
export const roundSec = (n: number): number => Math.round(n * 100) / 100;
