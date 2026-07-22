/**
 * Stage an episode's rendered audio onto the NAS Music share (flow step 7a).
 *
 * Navidrome's music mount is read-only, so we copy via a host that has the share
 * mounted read-write (the PVE host; see settings.toml [nas]) over SSH. `--replace`
 * mirrors (removes stale files); optionally triggers a Navidrome rescan afterward.
 *
 * The destination-path computation is pure (unit-tested); the ssh/rsync is I/O.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { config } from "./config";
import { clientFromEnv } from "./navidrome";

/** Remote folder for an episode: <musicDir>/<workdir-basename lowercased>. Pure. */
export function stageDest(workdir: string, musicDir: string): string {
  return `${musicDir.replace(/\/+$/, "")}/${basename(workdir.replace(/\/+$/, "")).toLowerCase()}`;
}

export interface StageOptions {
  replace?: boolean; // mirror: remove files on the NAS that aren't in the local audio dir
  rescan?: boolean; // trigger a Navidrome rescan after copying
  sshHost?: string;
  musicDir?: string;
}

export interface StageResult {
  host: string;
  dest: string;
  files: number;
  replaced: boolean;
  rescanned: boolean;
}

export async function stageAudio(workdir: string, opts: StageOptions = {}): Promise<StageResult> {
  const audioDir = join(workdir, "audio");
  if (!existsSync(audioDir)) {
    throw new Error(`no audio directory at ${audioDir} — render the episode first`);
  }
  const mp3s = readdirSync(audioDir).filter((f) => f.toLowerCase().endsWith(".mp3"));
  if (mp3s.length === 0) throw new Error(`no .mp3 files in ${audioDir}`);

  const host = opts.sshHost ?? config.nas.sshHost;
  const musicDir = opts.musicDir ?? config.nas.musicDir;
  const dest = stageDest(workdir, musicDir);

  // Ensure the destination folder exists, then rsync the audio dir into it.
  // -rt (recursive + mtimes for incremental), NOT -a: the NAS is an NFS share that
  // rejects chown/chmod (root-squash), so preserving owner/group/perms errors out.
  execFileSync("ssh", [host, `mkdir -p ${JSON.stringify(dest)}`], { stdio: "inherit" });
  const rsyncArgs = ["-rt", "--no-perms", "--include=*.mp3", "--include=*/", "--exclude=*"];
  if (opts.replace) rsyncArgs.push("--delete");
  rsyncArgs.push(`${audioDir}/`, `${host}:${dest}/`);
  execFileSync("rsync", rsyncArgs, { stdio: "inherit" });

  // Optionally make Navidrome index the new files (else it picks them up on its hourly scan).
  let rescanned = false;
  if (opts.rescan) {
    await clientFromEnv().startScan();
    rescanned = true;
  }

  return { host, dest, files: mp3s.length, replaced: !!opts.replace, rescanned };
}
