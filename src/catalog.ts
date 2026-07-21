/**
 * Read and safely mutate the episode catalog (`seasons.md`).
 *
 * Operates on the raw markdown lines so surrounding prose is never disturbed —
 * only per-season table rows change. Fence-aware, so the illustrative example
 * table in seasons.md is ignored.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "seasons.md");

const SEASON_HEADING = /^##\s+Season\s+(\d+)/i;
const ACTIVE_SEASON = /Active season:\s*\*{0,2}(\d+)/i;
const PLACEHOLDER_MARK = "no episodes yet";
const EMPTY = "—";

export class CatalogError extends Error {}

export interface Row {
  season: number;
  ep: number | null; // null for the placeholder row
  album: string;
  artist: string;
  host: string;
  status: string;
  dir: string;
  published: string;
  lineno: number; // 0-based index into the file's line list
}

export interface AssignResult {
  season: number;
  episode: number;
  dir: string;
  action: "claimed" | "appended";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "untitled";
}

function cells(line: string): string[] {
  let parts = line.trim().split("|").map((c) => c.trim());
  if (parts.length && parts[0] === "") parts = parts.slice(1);
  if (parts.length && parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  return parts;
}

const isTableLine = (line: string): boolean => line.trim().startsWith("|");
const isSeparator = (line: string): boolean => isTableLine(line) && /^[|:\-\s]+$/.test(line.trim());
const isHeader = (line: string): boolean => cells(line)[0] === "Ep";
const isPlaceholder = (line: string): boolean => line.toLowerCase().includes(PLACEHOLDER_MARK);

/** Blank out lines inside ``` / ~~~ code fences, preserving line indices. */
function maskFences(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const stripped = line.replace(/^\s+/, "");
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out;
}

interface TableLoc {
  headerIdx: number;
  dataIndices: number[];
  hasPlaceholder: boolean;
}

function locateTable(lines: string[], season: number): TableLoc {
  const masked = maskFences(lines);
  let start = -1;
  for (let i = 0; i < masked.length; i++) {
    const m = masked[i]!.match(SEASON_HEADING);
    if (m && parseInt(m[1]!, 10) === season) {
      start = i;
      break;
    }
  }
  if (start === -1) throw new CatalogError(`Season ${season} not found in catalog`);

  let headerIdx = -1;
  for (let i = start + 1; i < masked.length; i++) {
    if (SEASON_HEADING.test(masked[i]!)) break;
    if (isTableLine(masked[i]!) && isHeader(masked[i]!)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new CatalogError(`Season ${season} has no table`);

  const dataIndices: number[] = [];
  let hasPlaceholder = false;
  let i = headerIdx + 1;
  while (i < masked.length && isTableLine(masked[i]!)) {
    if (!isSeparator(masked[i]!) && !isHeader(masked[i]!)) {
      dataIndices.push(i);
      if (isPlaceholder(masked[i]!)) hasPlaceholder = true;
    }
    i++;
  }
  return { headerIdx, dataIndices, hasPlaceholder };
}

export function read(path: string = DEFAULT_PATH): string {
  return readFileSync(path, "utf-8");
}

export function activeSeason(text: string): number {
  const m = text.match(ACTIVE_SEASON);
  if (!m) throw new CatalogError("no 'Active season:' marker found in catalog");
  return parseInt(m[1]!, 10);
}

export function rowsForSeason(text: string, season: number): Row[] {
  const lines = text.split("\n");
  const { dataIndices } = locateTable(lines, season);
  const out: Row[] = [];
  for (const idx of dataIndices) {
    if (isPlaceholder(lines[idx]!)) continue;
    const c = cells(lines[idx]!);
    while (c.length < 7) c.push("");
    const ep = /^\d+$/.test(c[0]!) ? parseInt(c[0]!, 10) : null;
    out.push({
      season, ep, album: c[1]!, artist: c[2]!, host: c[3]!,
      status: c[4]!, dir: c[5]!, published: c[6]!, lineno: idx,
    });
  }
  return out;
}

export function nextEpisode(text: string, season: number): number {
  const eps = rowsForSeason(text, season)
    .map((r) => r.ep)
    .filter((e): e is number => e !== null);
  return eps.length ? Math.max(...eps) + 1 : 1;
}

function formatRow(ep: number, album: string, artist: string, host: string,
                   status: string, dir: string, published: string): string {
  return `| ${pad2(ep)} | ${album} | ${artist} | ${host} | ${status} | ${dir} | ${published} |`;
}

/** Claim a matching `planned` row or append the next episode; set it in-production. */
export function assign(album: string, artist: string, host: string,
                       season?: number, path: string = DEFAULT_PATH): AssignResult {
  const text = readFileSync(path, "utf-8");
  const seas = season ?? activeSeason(text);
  const lines = text.split("\n");
  const { headerIdx, dataIndices, hasPlaceholder } = locateTable(lines, seas);

  for (const r of rowsForSeason(text, seas)) {
    if (r.status.toLowerCase() === "planned"
        && r.album.toLowerCase() === album.toLowerCase()
        && r.artist.toLowerCase() === artist.toLowerCase()) {
      const ep = r.ep ?? nextEpisode(text, seas);
      const d = `S${pad2(seas)}E${pad2(ep)}-${slug(album)}`;
      lines[r.lineno] = formatRow(ep, r.album, r.artist, host, "in-production", d, EMPTY);
      writeFileSync(path, lines.join("\n") + "\n", "utf-8");
      return { season: seas, episode: ep, dir: d, action: "claimed" };
    }
  }

  const ep = nextEpisode(text, seas);
  const d = `S${pad2(seas)}E${pad2(ep)}-${slug(album)}`;
  const newRow = formatRow(ep, album, artist, host, "in-production", d, EMPTY);
  if (hasPlaceholder) {
    const ph = dataIndices.find((i) => isPlaceholder(lines[i]!))!;
    lines[ph] = newRow;
  } else {
    const insertAt = (dataIndices.length ? dataIndices[dataIndices.length - 1]! : headerIdx) + 1;
    lines.splice(insertAt, 0, newRow);
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  return { season: seas, episode: ep, dir: d, action: "appended" };
}

export function setStatus(season: number, ep: number, status: string,
                          published?: string, path: string = DEFAULT_PATH): void {
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  for (const r of rowsForSeason(text, season)) {
    if (r.ep === ep) {
      const pub = published ?? r.published;
      lines[r.lineno] = formatRow(ep, r.album, r.artist, r.host, status, r.dir, pub);
      writeFileSync(path, lines.join("\n") + "\n", "utf-8");
      return;
    }
  }
  throw new CatalogError(`S${pad2(season)}E${pad2(ep)} not found in catalog`);
}
