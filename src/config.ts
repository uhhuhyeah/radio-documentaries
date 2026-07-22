/**
 * Pipeline settings — loaded from settings.toml (the one place to change models &
 * voices). Env vars override the matching value when set. Falls back to sane
 * defaults if the file is absent, so tests and fresh checkouts still run.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";

import { loadDotenv } from "./navidrome";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.DOCS_CONFIG ?? join(REPO_ROOT, "settings.toml");

// Load .env into process.env BEFORE the eager loadConfig() below reads it, so DOCS_* env
// overrides (e.g. DOCS_NAS_LOCAL) apply even when an entrypoint imports `config` before it
// calls loadDotenv itself (ESM evaluates this module at import time). loadDotenv is
// non-overriding, so a value already set (e.g. by a systemd EnvironmentFile) still wins.
// Skipped under vitest to keep tests hermetic — they set env explicitly.
if (!process.env.VITEST) loadDotenv(join(REPO_ROOT, ".env"));

export interface VoiceConfig {
  voiceId: string;
  speed: number;
}

export interface Config {
  models: { research: string; write: string; producer: string; verify: string; timeoutMs: number };
  elevenlabs: { model: string };
  voices: Record<string, VoiceConfig>;
  /** Spend limits for the credit hard-stop (src/credit.ts). */
  budget: { perEpisodeCap: number };
  /**
   * How rendered audio reaches the NAS Music share. On the pipeline LXC the share is
   * bind-mounted read-write, so `local: true` copies straight to `musicDir` (no SSH). On a
   * dev box without the mount, `local: false` (default) rsyncs over SSH to a host that has it.
   */
  nas: { sshHost: string; musicDir: string; local: boolean };
  /** The MCP HTTP server (src/mcp.ts). Port only — the bearer token stays env-only (secret). */
  mcp: { port: number };
  /**
   * Base directory the pipeline creates episode working dirs under (research.md, script.md,
   * audio/…). The tools own this path so a REMOTE orchestrator (Hermes, on another host) never
   * has to invent a filesystem path — catalog_assign returns `<dir>/<episode>` and the tools
   * mkdir it. Default: the repo root (matches where episodes have always lived); override with
   * DOCS_WORK_DIR on a box where the repo dir isn't writable by the service user.
   */
  work: { dir: string };
}

const DEFAULTS: Config = {
  models: {
    research: "qwen/qwen3-30b-a3b-instruct-2507",
    write: "qwen/qwen3-30b-a3b-instruct-2507",
    producer: "qwen/qwen3-235b-a22b-2507",
    verify: "qwen/qwen3-30b-a3b-instruct-2507",
    timeoutMs: 300_000,
  },
  elevenlabs: { model: "eleven_flash_v2_5" },
  voices: {
    p_cara: { voiceId: "ZF6FPAbjXT4488VcRRnw", speed: 1.1 },
    p_jools: { voiceId: "1BUhH8aaMvGMUdGAmWVM", speed: 1.0 },
  },
  // Per-episode credit ceiling for the render hard-stop. ~9k credits/episode observed;
  // 15000 leaves headroom without allowing a runaway. Live-balance check guards the key
  // quota; no monthly ceiling (1 episode/month — a monthly ledger is a separate package).
  budget: { perEpisodeCap: 15000 },
  // The PVE host has the NAS Music share mounted read-write; Navidrome's LXC mount is read-only.
  // Default (dev): SSH to that host. The pipeline LXC sets nas.local + a local musicDir instead.
  nas: { sshHost: "root@100.110.0.9", musicDir: "/mnt/nas/music/subwave-documentaries", local: false },
  // MCP HTTP server port. Hermes (CTID 105) connects to it as a remote toolset over the LAN.
  mcp: { port: 8848 },
  // Episode working dirs are created under the repo root by default (where they've always lived).
  // DOCS_WORK_DIR overrides it if the service user can't write the repo dir on a given box.
  work: { dir: REPO_ROOT },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function loadConfig(path: string = CONFIG_PATH): Config {
  const raw: any = existsSync(path) ? parseToml(readFileSync(path, "utf-8")) : {};
  const m = raw.models ?? {};
  const el = raw.elevenlabs ?? {};
  const bg = raw.budget ?? {};
  const mcp = raw.mcp ?? {};

  const voices: Record<string, VoiceConfig> = {};
  for (const [id, v] of Object.entries<any>(raw.voices ?? {})) {
    voices[id] = { voiceId: String(v.voice_id ?? ""), speed: Number(v.speed ?? 1) };
  }

  return {
    models: {
      research: process.env.DOCS_RESEARCH_MODEL ?? m.research ?? DEFAULTS.models.research,
      write: process.env.DOCS_WRITE_MODEL ?? m.write ?? DEFAULTS.models.write,
      producer: process.env.DOCS_PRODUCER_MODEL ?? m.producer ?? DEFAULTS.models.producer,
      verify: process.env.DOCS_VERIFY_MODEL ?? m.verify ?? DEFAULTS.models.verify,
      timeoutMs: Number(process.env.DOCS_LLM_TIMEOUT_MS ?? m.timeout_ms ?? DEFAULTS.models.timeoutMs),
    },
    elevenlabs: { model: el.model ?? DEFAULTS.elevenlabs.model },
    voices: Object.keys(voices).length ? voices : DEFAULTS.voices,
    budget: {
      perEpisodeCap: Number(process.env.DOCS_PER_EPISODE_CAP ?? bg.per_episode_cap ?? DEFAULTS.budget.perEpisodeCap),
    },
    nas: {
      sshHost: process.env.DOCS_NAS_SSH_HOST ?? raw.nas?.ssh_host ?? DEFAULTS.nas.sshHost,
      musicDir: process.env.DOCS_NAS_MUSIC_DIR ?? raw.nas?.music_dir ?? DEFAULTS.nas.musicDir,
      local:
        process.env.DOCS_NAS_LOCAL != null
          ? /^(1|true|yes|on)$/i.test(process.env.DOCS_NAS_LOCAL)
          : Boolean(raw.nas?.local ?? DEFAULTS.nas.local),
    },
    mcp: {
      port: Number(process.env.DOCS_MCP_PORT ?? mcp.port ?? DEFAULTS.mcp.port),
    },
    work: {
      dir: process.env.DOCS_WORK_DIR ?? raw.work?.dir ?? DEFAULTS.work.dir,
    },
  };
}

/** Loaded once at import. Change settings.toml and re-run the process to pick up edits. */
export const config: Config = loadConfig();
