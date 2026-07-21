/**
 * Parse an episode `script.md` into front matter + ordered slots.
 *
 * Executable counterpart of the contract in `script-format.md`, and the shared
 * foundation for lint, budget, and render. Pure (no I/O) except `loadEpisode`.
 *
 * Front matter is a deliberately-flat YAML block (string / quoted-string / int
 * values only), so a tiny parser handles it without a YAML dependency.
 */

import { readFileSync } from "node:fs";

export type SlotKind = "SPOKEN" | "SONG";

export interface Slot {
  index: number;
  kind: SlotKind;
  label: string;
  /** SPOKEN: verbatim TTS text. SONG: empty. */
  body: string;
  /** SONG: title/artist/album/note. */
  meta: Record<string, string>;
  lineno: number;
}

export type FrontMatter = Record<string, string | number>;

export interface Episode {
  frontMatter: FrontMatter;
  slots: Slot[];
}

export class ScriptError extends Error {}

// ## [NN] SPOKEN · label   /   ## [NN] SONG · label
const SLOT_HEADING = /^##\s+\[(\d{2})\]\s+(SPOKEN|SONG)\s*·\s*(.+?)\s*$/;
// Looks like a slot heading but may not fully parse (to catch typos).
const SLOT_HEADING_LOOSE = /^##\s+\[/;
// A SONG metadata line:  - title: "Kyoto"
const META_LINE = /^-\s+(\w+):\s*(.+?)\s*$/;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** MP3 filename for a SPOKEN slot (SONG slots produce no file). */
export function segmentFilename(season: number, episode: number, slot: Slot): string {
  return `s${pad2(season)}e${pad2(episode)}_${pad2(slot.index)}_${slot.label}.mp3`;
}

function unquote(v: string): string {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

function coerce(v: string): string | number {
  const s = v.trim();
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return unquote(s);
}

/** Drop a trailing `# comment` on an unquoted value; leave quoted values alone. */
function stripInlineComment(v: string): string {
  const t = v.trim();
  if (t[0] === '"' || t[0] === "'") return t;
  const i = t.indexOf("#");
  return (i === -1 ? t : t.slice(0, i)).trim();
}

export function parseFrontMatter(block: string): FrontMatter {
  const fm: FrontMatter = {};
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    const key = line.slice(0, idx).trim();
    fm[key] = coerce(stripInlineComment(line.slice(idx + 1)));
  }
  return fm;
}

/** Return [frontMatterBlock, body]. Body starts after the closing '---'. */
export function splitFrontMatter(text: string): [string, string] {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0]?.trim() !== "---") return ["", text];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return [lines.slice(1, i).join("\n"), lines.slice(i + 1).join("\n")];
    }
  }
  throw new ScriptError("front matter opened with '---' but never closed");
}

export function parse(text: string): Episode {
  const [fmBlock, body] = splitFrontMatter(text);
  const frontMatter = parseFrontMatter(fmBlock);

  const slots: Slot[] = [];
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i]!.match(SLOT_HEADING);
    if (!m) {
      i++;
      continue;
    }
    const index = parseInt(m[1]!, 10);
    const kind = m[2] as SlotKind;
    const label = m[3]!.trim();
    const headingLineno = i + 1;

    i++;
    const chunk: string[] = [];
    while (i < lines.length && !SLOT_HEADING.test(lines[i]!)) {
      chunk.push(lines[i]!);
      i++;
    }

    const slot: Slot = { index, kind, label, body: "", meta: {}, lineno: headingLineno };
    if (kind === "SONG") {
      for (const cl of chunk) {
        const mm = cl.trim().match(META_LINE);
        if (mm) slot.meta[mm[1]!.toLowerCase()] = unquote(mm[2]!.trim());
      }
    } else {
      slot.body = chunk.join("\n").trim();
    }
    slots.push(slot);
  }

  return { frontMatter, slots };
}

export function loadEpisode(path: string): Episode {
  return parse(readFileSync(path, "utf-8"));
}

export const spokenSlots = (ep: Episode): Slot[] => ep.slots.filter((s) => s.kind === "SPOKEN");
export const songSlots = (ep: Episode): Slot[] => ep.slots.filter((s) => s.kind === "SONG");

/** Lines that start like a slot heading but don't parse — likely typos. */
export function findMalformedHeadings(text: string): Array<[number, string]> {
  const [, body] = splitFrontMatter(text);
  const out: Array<[number, string]> = [];
  body.split("\n").forEach((line, idx) => {
    if (SLOT_HEADING_LOOSE.test(line) && !SLOT_HEADING.test(line)) {
      out.push([idx + 1, line.replace(/\s+$/, "")]);
    }
  });
  return out;
}
