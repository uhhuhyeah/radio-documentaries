/**
 * Stage an episode's rendered audio onto the NAS Music share (flow step 7a).
 *
 * Two modes (see settings.toml [nas]):
 *  - **local** (the pipeline LXC): the Music share is bind-mounted read-write, so we copy
 *    straight to `musicDir` — no SSH, keeps the container sandboxed.
 *  - **ssh** (a dev box without the mount): rsync over SSH to a host that has the share
 *    mounted read-write (the PVE host). Navidrome's own mount is read-only either way.
 *
 * `--replace` mirrors (removes stale files); optionally triggers + waits on a Navidrome rescan.
 * The path + mirror-set computations are pure (unit-tested); the copy/ssh/rsync is I/O.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { config } from "./config";
import { clientFromEnv, waitForScan } from "./navidrome";

const isMp3 = (f: string): boolean => f.toLowerCase().endsWith(".mp3");

/** Destination folder for an episode: <musicDir>/<workdir-basename lowercased>. Pure. */
export function stageDest(workdir: string, musicDir: string): string {
  return `${musicDir.replace(/\/+$/, "")}/${basename(workdir.replace(/\/+$/, "")).toLowerCase()}`;
}

/** Destination .mp3 files that aren't in the source set — removed on a `--replace` mirror. Pure. */
export function staleFiles(sourceMp3s: string[], destMp3s: string[]): string[] {
  const keep = new Set(sourceMp3s);
  return destMp3s.filter((f) => !keep.has(f));
}

export interface StageOptions {
  replace?: boolean; // mirror: remove files at the dest that aren't in the local audio dir
  rescan?: boolean; // trigger a Navidrome rescan after copying
  wait?: boolean; // with rescan: block until the rescan settles (so publish isn't run against a half-scanned library)
  timeoutMs?: number; // waitForScan timeout (default 120s)
  intervalMs?: number; // waitForScan poll interval (default 2s)
  local?: boolean; // copy to a local (bind-mounted) musicDir instead of rsync-over-ssh
  sshHost?: string;
  musicDir?: string;
}

export interface StageResult {
  host: string; // "local" in local mode, else the ssh host
  dest: string;
  files: number;
  replaced: boolean;
  rescanned: boolean;
  waited: boolean;
}

export async function stageAudio(workdir: string, opts: StageOptions = {}): Promise<StageResult> {
  const audioDir = join(workdir, "audio");
  if (!existsSync(audioDir)) {
    throw new Error(`no audio directory at ${audioDir} — render the episode first`);
  }
  const mp3s = readdirSync(audioDir).filter(isMp3);
  if (mp3s.length === 0) throw new Error(`no .mp3 files in ${audioDir}`);

  const local = opts.local ?? config.nas.local;
  const host = opts.sshHost ?? config.nas.sshHost;
  const musicDir = opts.musicDir ?? config.nas.musicDir;
  const dest = stageDest(workdir, musicDir);

  if (local) {
    // Pipeline LXC: the share is bind-mounted read-write — copy straight in, no SSH.
    mkdirSync(dest, { recursive: true });
    for (const f of mp3s) copyFileSync(join(audioDir, f), join(dest, f));
    if (opts.replace) {
      const present = readdirSync(dest).filter(isMp3);
      for (const f of staleFiles(mp3s, present)) rmSync(join(dest, f));
    }
  } else {
    // Dev box: rsync over SSH to a host that has the share mounted read-write.
    // -rt (recursive + mtimes for incremental), NOT -a: the NAS is an NFS share that rejects
    // chown/chmod (root-squash), so preserving owner/group/perms errors out.
    execFileSync("ssh", [host, `mkdir -p ${JSON.stringify(dest)}`], { stdio: "inherit" });
    const rsyncArgs = ["-rt", "--no-perms", "--include=*.mp3", "--include=*/", "--exclude=*"];
    if (opts.replace) rsyncArgs.push("--delete");
    rsyncArgs.push(`${audioDir}/`, `${host}:${dest}/`);
    execFileSync("rsync", rsyncArgs, { stdio: "inherit" });
  }

  // Optionally make Navidrome index the new files (else it picks them up on its hourly scan).
  // The flow is stage → rescan → WAIT → publish: with `wait`, block here until the rescan
  // settles so the caller (or Hermes) can publish immediately without racing a half-scan.
  let rescanned = false;
  let waited = false;
  if (opts.rescan) {
    const client = clientFromEnv();
    await client.startScan();
    rescanned = true;
    if (opts.wait) {
      await waitForScan(client, { timeoutMs: opts.timeoutMs, intervalMs: opts.intervalMs });
      waited = true;
    }
  }

  return { host: local ? "local" : host, dest, files: mp3s.length, replaced: !!opts.replace, rescanned, waited };
}
