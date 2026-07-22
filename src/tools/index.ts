/**
 * The deterministic modules exposed to the Pi Producer agent as tools.
 *
 * Each `defineTool` is a thin adapter over an already-tested function in the
 * domain modules — the agent calls these instead of the CLI. Return shape is
 * Pi's AgentToolResult: a text summary (for the model) plus structured `details`.
 */

import { Type } from "typebox";

import { defineTool } from "@earendil-works/pi-coding-agent";

import * as budget from "../budget";
import * as catalog from "../catalog";
import { factCheckFiles } from "../factcheck";
import * as lint from "../lint";
import { clientFromEnv, songsOfAlbum } from "../navidrome";
import { DEFAULT_LYRICS_THRESHOLD, runPreflight } from "../preflight";
import { renderEpisode } from "../render";
import { stageAudio } from "../stage";
import { researchAlbumTool, writeScriptTool } from "./subagents";
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
  label: "Catalog: next episode",
  description: "Return the next episode number for a season (defaults to the active season).",
  parameters: Type.Object({
    season: Type.Optional(Type.Integer({ description: "Season number; omit for the active season." })),
  }),
  execute: async (_id, params) => {
    const text = catalog.read();
    const season = params.season ?? catalog.activeSeason(text);
    const next = catalog.nextEpisode(text, season);
    return result(`Season ${season}: next episode is ${next}.`, { season, next });
  },
});

export const catalogListTool = defineTool({
  name: "catalog_list",
  label: "Catalog: list",
  description: "List the episodes recorded for a season.",
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
    "Claim a matching planned row or append the next episode, setting it in-production. " +
    "Returns the assigned season/episode and the working-directory name to create.",
  parameters: Type.Object({
    album: Type.String(),
    artist: Type.String(),
    host: Type.String({ description: "Display name, e.g. Cara or Jools." }),
    season: Type.Optional(Type.Integer()),
  }),
  execute: async (_id, params) => {
    const r = catalog.assign(params.album, params.artist, params.host, params.season);
    return result(
      `${r.action}: S${String(r.season).padStart(2, "0")}E${String(r.episode).padStart(2, "0")} → ${r.dir}`,
      r,
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
    "re-publishing, rescan=true to trigger a Navidrome scan afterward. Run before navidrome publish.",
  parameters: Type.Object({
    workdir: Type.String({ description: "Episode working dir, e.g. S01E01-punisher" }),
    replace: Type.Optional(Type.Boolean({ description: "Mirror: remove NAS files not in the local audio dir." })),
    rescan: Type.Optional(Type.Boolean({ description: "Trigger a Navidrome rescan after copying." })),
  }),
  execute: async (_id, params) => {
    const r = await stageAudio(params.workdir, { replace: params.replace, rescan: params.rescan });
    return result(`staged ${r.files} file(s) → ${r.host}:${r.dest}${r.rescanned ? " (rescan triggered)" : ""}`, r);
  },
});

/** All tools the Producer agent may call. */
export const documentaryTools = [
  preflightTool,
  catalogNextTool,
  catalogListTool,
  catalogAssignTool,
  catalogSetStatusTool,
  researchAlbumTool,
  writeScriptTool,
  lintScriptTool,
  factCheckScriptTool,
  budgetEstimateTool,
  renderEpisodeTool,
  stageAudioTool,
  navidromeFindAlbumTool,
  navidromeAlbumSongsTool,
  navidromeScanStatusTool,
  navidromeCreatePlaylistTool,
];
