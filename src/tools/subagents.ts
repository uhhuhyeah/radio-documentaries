/**
 * Sub-agents exposed to the Producer as tools (the "agent-as-tool" pattern).
 * The Producer calls research_album then write_script; each runs a sub-agent and
 * leaves its output as a file in the working directory.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { Type } from "typebox";

import { defineTool } from "@earendil-works/pi-coding-agent";

import { researchAlbum } from "../agents/researcher";
import { writeScript } from "../agents/writer";
import { toolResult } from "./util";

export const researchAlbumTool = defineTool({
  name: "research_album",
  label: "Research album",
  description:
    "Run the Researcher sub-agent to web-research an album's making-of and write organised notes to notesPath.",
  parameters: Type.Object({
    album: Type.String(),
    artist: Type.String(),
    notesPath: Type.String({ description: "Where to write the notes, e.g. <workdir>/research.md" }),
    focus: Type.Optional(Type.String()),
  }),
  execute: async (_id, p) => {
    await researchAlbum(p.album, p.artist, p.notesPath, p.focus);
    return toolResult(`research notes written to ${p.notesPath}`, { notesPath: p.notesPath });
  },
});

export const writeScriptTool = defineTool({
  name: "write_script",
  label: "Write script",
  description:
    "Run the Writer sub-agent to turn research notes into a format-compliant script.md. " +
    "Uses ONLY the notes (no web). Lint the result afterwards.",
  parameters: Type.Object({
    researchPath: Type.String(),
    outPath: Type.String({ description: "Where to write script.md" }),
    album: Type.String(),
    artist: Type.String(),
    host: Type.String({ description: "Persona id, e.g. p_jools" }),
    hostName: Type.String({ description: "Cara | Jools" }),
    season: Type.Integer(),
    episode: Type.Integer(),
    model: Type.Optional(Type.String()),
    targetMinutes: Type.Optional(Type.Integer()),
    referenceTracks: Type.Optional(Type.Integer()),
  }),
  execute: async (_id, p) => {
    const research = readFileSync(p.researchPath, "utf-8");
    const script = await writeScript({
      album: p.album,
      artist: p.artist,
      host: p.host,
      hostName: p.hostName,
      season: p.season,
      episode: p.episode,
      model: p.model,
      targetMinutes: p.targetMinutes,
      referenceTracks: p.referenceTracks,
      research,
    });
    writeFileSync(p.outPath, script, "utf-8");
    return toolResult(`script written to ${p.outPath} (${script.length} chars)`, { outPath: p.outPath });
  },
});
