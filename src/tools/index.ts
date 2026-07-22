/**
 * The deterministic modules exposed to the Pi Producer agent as tools.
 *
 * Each `defineTool` is a thin adapter over an already-tested function in the
 * domain modules — the agent calls these instead of the CLI. Return shape is
 * Pi's AgentToolResult: a text summary (for the model) plus structured `details`.
 */

import { join } from "node:path";

import { Type } from "typebox";

import { defineTool } from "@earendil-works/pi-coding-agent";

import * as budget from "../budget";
import * as catalog from "../catalog";
import { config } from "../config";
import { checkCredit } from "../credit";
import { apiKeyFromEnv } from "../elevenlabs";
import { factCheckFiles } from "../factcheck";
import * as lint from "../lint";
import { clientFromEnv, songsOfAlbum, waitForScan } from "../navidrome";
import { DEFAULT_LYRICS_THRESHOLD, runPreflight } from "../preflight";
import * as qa from "../qa";
import { renderEpisode } from "../render";
import { stageAudio } from "../stage";
import { researchAlbumTool, researchStatusTool, waitResearchTool, writeScriptTool } from "./subagents";
import { toolResult as result } from "./util";

// --- preflight (network; the make-ability gate) ------------------------------

export const preflightTool = defineTool({
  name: "preflight",
  label: "Preflight make-ability gate",
  description:
    "Make-ability gate to run BEFORE research/render effort. Checks the album resolves in Navidrome " +
    "(HARD fail — publish needs its reference tracks), that enough track lyrics resolve (SOFT fail — low " +
    "lyrics mean a thin/short episode), and that the required API keys are set (HARD fail). Returns each " +
    "check's status and whether it's safe to make the episode; do not proceed on a hard fail.",
  parameters: Type.Object({
    album: Type.String(),
    artist: Type.String(),
    lyricsThreshold: Type.Optional(
      Type.Number({ description: "Min fraction of tracks that must resolve lyrics (default 0.8)." }),
    ),
  }),
  execute: async (_id, params) => {
    const report = await runPreflight(params.album, params.artist, params.lyricsThreshold ?? DEFAULT_LYRICS_THRESHOLD);
    const lines = report.checks.map((c) => `  [${c.status}] ${c.name}: ${c.detail}`).join("\n");
    const verdict = report.ok
      ? "OK — safe to make"
      : report.hardFail
        ? "HARD FAIL — do not proceed"
        : "SOFT FAIL — proceed with caution";
    return result(`preflight: ${verdict}\n${lines}`, report);
  },
});

// --- catalog -----------------------------------------------------------------

export const catalogNextTool = defineTool({
  name: "catalog_next",
  label: "Catalog: next append number",
  description:
    "The next episode NUMBER to APPEND a brand-new, unplanned episode to a season (max existing + 1). " +
    "This is NOT what to produce next — for a planned queue use catalog_next_planned. You rarely need " +
    "this: catalog_assign computes the append number itself when no planned row matches.",
  parameters: Type.Object({
    season: Type.Optional(Type.Integer({ description: "Season number; omit for the active season." })),
  }),
  execute: async (_id, params) => {
    const text = catalog.read();
    const season = params.season ?? catalog.activeSeason(text);
    const next = catalog.nextEpisode(text, season);
    return result(`Season ${season}: next APPEND number is ${next} (not necessarily what to produce next).`, {
      season,
      next,
    });
  },
});

export const catalogNextPlannedTool = defineTool({
  name: "catalog_next_planned",
  label: "Catalog: next planned episode",
  description:
    "The next episode to PRODUCE: the first row still marked `planned` in the season (queue order). " +
    "This is the answer to \"what's next?\". Returns null when nothing is planned. Feed its album/artist/" +
    "host to catalog_assign to claim it.",
  parameters: Type.Object({
    season: Type.Optional(Type.Integer({ description: "Season number; omit for the active season." })),
  }),
  execute: async (_id, params) => {
    const text = catalog.read();
    const season = params.season ?? catalog.activeSeason(text);
    const row = catalog.nextPlanned(text, season);
    const summary = row
      ? `Season ${season}: next planned is E${String(row.ep).padStart(2, "0")} — ${row.album} by ${row.artist} (host ${row.host}).`
      : `Season ${season}: nothing planned.`;
    return result(summary, { season, row });
  },
});

export const catalogListTool = defineTool({
  name: "catalog_list",
  label: "Catalog: list",
  description: "List all episode rows for a season with their status (planned | in-production | recorded | published).",
  parameters: Type.Object({ season: Type.Optional(Type.Integer()) }),
  execute: async (_id, params) => {
    const text = catalog.read();
    const season = params.season ?? catalog.activeSeason(text);
    const rows = catalog.rowsForSeason(text, season);
    return result(`Season ${season}: ${rows.length} episode(s).`, { season, rows });
  },
});

export const catalogAssignTool = defineTool({
  name: "catalog_assign",
  label: "Catalog: assign episode",
  description:
    "Claim a matching planned row or append the next episode, setting it in-production. Returns the " +
    "assigned season/episode plus the ABSOLUTE working-directory path on the pipeline host — pass that " +
    "`workdir` (and `<workdir>/research.md`, `<workdir>/script.md`) straight to the other tools. The " +
    "tools create the directory; do NOT try to mkdir it yourself (a remote orchestrator has no " +
    "filesystem on this host).",
  parameters: Type.Object({
    album: Type.String(),
    artist: Type.String(),
    host: Type.String({ description: "Display name, e.g. Cara or Jools." }),
    season: Type.Optional(Type.Integer()),
  }),
  execute: async (_id, params) => {
    const r = catalog.assign(params.album, params.artist, params.host, params.season);
    const workdir = join(config.work.dir, r.dir);
    return result(
      `${r.action}: S${String(r.season).padStart(2, "0")}E${String(r.episode).padStart(2, "0")} → ${workdir}`,
      { ...r, workdir },
    );
  },
});

export const catalogSetStatusTool = defineTool({
  name: "catalog_set_status",
  label: "Catalog: set status",
  description: "Update an episode's status (in-production | recorded | published) and optionally its published date.",
  parameters: Type.Object({
    season: Type.Integer(),
    episode: Type.Integer(),
    status: Type.String(),
    published: Type.Optional(Type.String({ description: "YYYY-MM-DD; set when publishing." })),
  }),
  execute: async (_id, params) => {
    catalog.setStatus(params.season, params.episode, params.status, params.published);
    return result(`S${String(params.season).padStart(2, "0")}E${String(params.episode).padStart(2, "0")} → ${params.status}`, {
      ok: true,
    });
  },
});

// --- lint / budget -----------------------------------------------------------

export const lintScriptTool = defineTool({
  name: "lint_script",
  label: "Lint script",
  description: "Validate a script.md against the format contract. Returns findings; errors block rendering.",
  parameters: Type.Object({ scriptPath: Type.String() }),
  execute: async (_id, params) => {
    const findings = lint.lintFile(params.scriptPath);
    const errors = findings.filter((f) => f.level === "ERROR").length;
    const warnings = findings.length - errors;
    const summary =
      findings.length === 0
        ? "lint: OK — no issues"
        : `lint: ${errors} error(s), ${warnings} warning(s)\n` + findings.map((f) => `  [${f.level}] ${f.msg}`).join("\n");
    return result(summary, { errors, warnings, findings });
  },
});

export const factCheckScriptTool = defineTool({
  name: "factcheck_script",
  label: "Fact-check script",
  description:
    "Check a script.md's album/making-of claims against the research notes. Flags CONTRADICTION and " +
    "UNSUPPORTED (invented) facts; ignores the host's persona colour, opinion, and lyrics. Advisory — " +
    "surfaces findings for review, does not block like lint.",
  parameters: Type.Object({ scriptPath: Type.String(), researchPath: Type.String() }),
  execute: async (_id, params) => {
    const findings = await factCheckFiles(params.scriptPath, params.researchPath);
    const contradictions = findings.filter((f) => f.severity === "CONTRADICTION").length;
    const summary =
      findings.length === 0
        ? "factcheck: OK — no unsupported or contradicted album-facts"
        : `factcheck: ${findings.length} finding(s), ${contradictions} contradiction(s)\n` +
          findings.map((f) => `  [${f.severity}] ${f.quote} — ${f.issue}`).join("\n");
    return result(summary, { findings, contradictions });
  },
});

export const qaScriptTool = defineTool({
  name: "qa_script",
  label: "QA script",
  description:
    "Deterministic quality gate for a script.md — complements lint. Checks lyric fidelity (any quoted, " +
    "lyric-like span must appear verbatim in the research's Track Lyrics bank; a miss is a possible " +
    "hallucinated lyric), estimated runtime vs target/house-range, the Subwave station ident in the " +
    "intro, no voiced [source] tags, and reference-track count + spread. Errors block; warnings inform.",
  parameters: Type.Object({ scriptPath: Type.String(), researchPath: Type.String() }),
  execute: async (_id, params) => {
    const findings = qa.qaFiles(params.scriptPath, params.researchPath);
    const errors = findings.filter((f) => f.level === "ERROR").length;
    const warnings = findings.length - errors;
    const summary =
      findings.length === 0
        ? "qa: OK — no issues"
        : `qa: ${errors} error(s), ${warnings} warning(s)\n` + findings.map((f) => `  [${f.level}] ${f.msg}`).join("\n");
    return result(summary, { errors, warnings, findings });
  },
});

export const budgetEstimateTool = defineTool({
  name: "budget_estimate",
  label: "Budget estimate",
  description: "Estimate ElevenLabs credits for a script (spoken text only). Optionally check a per-episode cap.",
  parameters: Type.Object({
    scriptPath: Type.String(),
    cap: Type.Optional(Type.Integer({ description: "Fail the cap check if the chosen model exceeds this." })),
  }),
  execute: async (_id, params) => {
    const e = budget.estimateFile(params.scriptPath);
    const cap = params.cap !== undefined ? budget.withinCap(e, params.cap) : null;
    const summary =
      `budget: ${e.chars} chars, ~${Math.round(e.spokenMinutes)} min spoken; ` +
      `${e.chosenModel ?? "?"} ≈ ${Math.round(e.chosenCredits ?? 0)} credits` +
      (cap === null ? "" : `; cap ${params.cap} → ${cap ? "OK" : "OVER"}`);
    return result(summary, { ...e, capOk: cap });
  },
});

// --- credit hard-stop (network; the render gate) -----------------------------

export const creditCheckTool = defineTool({
  name: "credit_check",
  label: "Credit hard-stop check",
  description:
    "Credit gate to run BEFORE render_episode. Estimates the episode's credit need, queries the " +
    "ElevenLabs key's live balance, and checks both the balance (can the render finish?) and the " +
    "per-episode cap. Returns ok=false with a reason if the render must be refused — do NOT render on " +
    "a fail. Fail-closed: a failed balance query aborts unless allowUnknownBalance is set.",
  parameters: Type.Object({
    scriptPath: Type.String(),
    model: Type.Optional(Type.String({ description: "TTS model id; omit to use the script's front-matter model." })),
    cap: Type.Optional(Type.Integer({ description: "Per-episode credit cap; omit for the configured default." })),
    allowUnknownBalance: Type.Optional(
      Type.Boolean({ description: "Proceed on a failed balance query (cap-only). Default false (fail-closed)." }),
    ),
  }),
  execute: async (_id, params) => {
    const e = budget.estimateFile(params.scriptPath);
    const modelId = params.model ?? e.chosenModel ?? config.elevenlabs.model;
    const cap = params.cap ?? config.budget.perEpisodeCap;
    const check = await checkCredit(params.scriptPath, modelId, apiKeyFromEnv(), cap, {
      allowUnknownBalance: params.allowUnknownBalance,
    });
    return result(`credit-check (${modelId}): ${check.ok ? "OK" : "ABORT"} — ${check.reason}`, check);
  },
});

// --- render (network; needs the ElevenLabs key) ------------------------------

export const renderEpisodeTool = defineTool({
  name: "render_episode",
  label: "Render episode",
  description:
    "Render a script.md to ID3-tagged MP3 segments via ElevenLabs and write the rundown cue sheet. " +
    "Costs credits — only call when approved. Needs ELEVENLABS_API_KEY.",
  parameters: Type.Object({ scriptPath: Type.String() }),
  execute: async (_id, params) => {
    const r = await renderEpisode(params.scriptPath);
    return result(`rendered ${r.rendered} segment(s) → ${r.audioDir}; cue → ${r.cuePath}`, r);
  },
});

// --- navidrome (network; used in the publish step) ---------------------------

export const navidromeFindAlbumTool = defineTool({
  name: "navidrome_find_album",
  label: "Navidrome: find album",
  description: "Resolve an album to its Subsonic id (and song count) in Navidrome.",
  parameters: Type.Object({ album: Type.String(), artist: Type.Optional(Type.String()) }),
  execute: async (_id, params) => {
    const a = await clientFromEnv().findAlbum(params.album, params.artist);
    if (!a) return result(`album not found: ${params.album}`, { found: false });
    return result(`${a.name} — ${a.artist} (id=${a.id}, songs=${a.songCount})`, { found: true, album: a });
  },
});

export const navidromeAlbumSongsTool = defineTool({
  name: "navidrome_album_songs",
  label: "Navidrome: album songs",
  description: "List an album's tracks with their Subsonic ids, in track order.",
  parameters: Type.Object({ albumId: Type.String() }),
  execute: async (_id, params) => {
    const songs = songsOfAlbum(await clientFromEnv().getAlbum(params.albumId));
    const lines = songs.map((s) => `${s.track ?? 0}. ${s.title} (id=${s.id})`).join("\n");
    return result(lines || "(no songs)", { songs });
  },
});

export const navidromeScanStatusTool = defineTool({
  name: "navidrome_scan_status",
  label: "Navidrome: scan status",
  description: "Report Navidrome's library scan status (whether a rescan is in progress and the track count).",
  parameters: Type.Object({}),
  execute: async () => {
    const st = await clientFromEnv().scanStatus();
    return result(JSON.stringify(st), st);
  },
});

export const waitScanTool = defineTool({
  name: "wait_scan",
  label: "Navidrome: wait for rescan",
  description:
    "Block until Navidrome's library rescan settles (scanning:false) or a timeout elapses. Run AFTER " +
    "stage_audio(rescan=true) and BEFORE publish so publishing never races a half-scanned library. " +
    "Throws on timeout. Defaults: timeout 120s, poll every 2s.",
  parameters: Type.Object({
    timeoutSec: Type.Optional(Type.Number({ description: "Max seconds to wait for the rescan to finish (default 120)." })),
    intervalSec: Type.Optional(Type.Number({ description: "Seconds between scan-status polls (default 2)." })),
  }),
  execute: async (_id, params) => {
    const st = await waitForScan(clientFromEnv(), {
      timeoutMs: params.timeoutSec !== undefined ? params.timeoutSec * 1000 : undefined,
      intervalMs: params.intervalSec !== undefined ? params.intervalSec * 1000 : undefined,
    });
    return result(`scan settled: ${JSON.stringify(st)}`, st);
  },
});

export const navidromeCreatePlaylistTool = defineTool({
  name: "navidrome_create_playlist",
  label: "Navidrome: create playlist",
  description: "Create a Navidrome playlist from an ordered list of Subsonic song ids (order is preserved).",
  parameters: Type.Object({
    name: Type.String(),
    songIds: Type.Array(Type.String()),
  }),
  execute: async (_id, params) => {
    const pl = await clientFromEnv().createPlaylist(params.name, params.songIds);
    return result(`created playlist "${params.name}" (${params.songIds.length} entries)`, { playlist: pl });
  },
});

export const stageAudioTool = defineTool({
  name: "stage_audio",
  label: "Stage audio to NAS",
  description:
    "Copy an episode's rendered MP3s from its working dir onto the NAS Music share (via the read-write " +
    "PVE host) so Navidrome can index them. Pass replace=true to mirror (remove stale files) when " +
    "re-publishing, rescan=true to trigger a Navidrome scan afterward, wait=true to also block until " +
    "that rescan settles (so publish is safe next). Run before navidrome publish.",
  parameters: Type.Object({
    workdir: Type.String({ description: "Episode working dir, e.g. S01E01-punisher" }),
    replace: Type.Optional(Type.Boolean({ description: "Mirror: remove NAS files not in the local audio dir." })),
    rescan: Type.Optional(Type.Boolean({ description: "Trigger a Navidrome rescan after copying." })),
    wait: Type.Optional(Type.Boolean({ description: "With rescan: block until the rescan settles before returning." })),
  }),
  execute: async (_id, params) => {
    const r = await stageAudio(params.workdir, { replace: params.replace, rescan: params.rescan, wait: params.wait });
    return result(
      `staged ${r.files} file(s) → ${r.host}:${r.dest}${r.rescanned ? " (rescan triggered)" : ""}${r.waited ? " (settled)" : ""}`,
      r,
    );
  },
});

/** All tools the Producer agent may call. */
export const documentaryTools = [
  preflightTool,
  catalogNextPlannedTool,
  catalogNextTool,
  catalogListTool,
  catalogAssignTool,
  catalogSetStatusTool,
  researchAlbumTool,
  waitResearchTool,
  researchStatusTool,
  writeScriptTool,
  lintScriptTool,
  factCheckScriptTool,
  qaScriptTool,
  budgetEstimateTool,
  creditCheckTool,
  renderEpisodeTool,
  stageAudioTool,
  navidromeFindAlbumTool,
  navidromeAlbumSongsTool,
  navidromeScanStatusTool,
  waitScanTool,
  navidromeCreatePlaylistTool,
];
