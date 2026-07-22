/**
 * Researcher — deterministic gather → synthesize (not an autonomous agent loop).
 *
 * A first attempt used a Pi agent free to search/fetch at will; it fired 20 blind
 * searches, never fetched a page, and tripped DuckDuckGo's block. This version is
 * predictable: a few targeted (Brave) searches → fetch the top unique pages →
 * one LLM synthesis over the actual page text. Reliable, cheap, polite.
 *
 * Exposed to the Producer via the research_album tool. Needs BRAVE_API_KEY (search)
 * and OPENROUTER_API_KEY (synthesis).
 */

import { writeFileSync } from "node:fs";

import { config } from "../config";
import { complete } from "../llm";
import { gatherAlbumLyrics } from "../tools/lyrics";
import { type SearchResult, sourceReliability, webFetchText, webSearch } from "../tools/web";
import { RESEARCHER_SYSTEM, VERIFIER_SYSTEM } from "./system-prompts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Research synthesis is factual organisation, not on-air patter — the config
// defaults it to a faster model than the DJ's qwen3-235b (settings.toml [models].research).
const RESEARCH_MODEL = config.models.research;
const VERIFY_MODEL = config.models.verify;
const MAX_PAGES = 10;
const PAGE_CHARS = 12_000;
const PER_QUERY = 6;

/**
 * Fact-check pass: re-read the draft notes against the source texts and quarantine
 * anything that's inferred or rests only on weak sources (mirrors an editorial
 * fact-checker). Best-effort — on failure we keep the unverified draft rather than
 * lose the research, but we flag it in the notes.
 */
async function verifyNotes(draft: string, sources: string[]): Promise<string> {
  const user = [
    "Fact-check and correct the DRAFT research notes below against the SOURCES.",
    "Move inferred / weak-source / single-source claims into the quarantine section; keep",
    "well-supported facts in the body with inline attribution. Output ONLY the corrected notes.",
    "",
    "--- DRAFT NOTES ---",
    draft,
    "",
    "--- SOURCES ---",
    sources.join("\n\n---\n\n"),
  ].join("\n");
  const verified = await complete(VERIFIER_SYSTEM, user, VERIFY_MODEL);
  if (!verified.trim()) {
    process.stderr.write("[researcher] verify produced no output — keeping unverified draft\n");
    return draft + "\n\n> ⚠️ Fact-check pass produced no output; the above is UNVERIFIED.\n";
  }
  return verified;
}

/**
 * Verbatim lyrics for the album's tracks (from LRCLIB), appended to the notes so
 * the Writer can quote real lyrics instead of inventing them. Track list comes
 * from Navidrome (the actual library album). Best-effort — returns "" on failure.
 */
async function gatherLyrics(album: string, artist: string): Promise<string> {
  try {
    const results = await gatherAlbumLyrics(album, artist);
    const blocks = results.filter((r) => r.lyrics).map((r) => `### ${r.track}\n\n${r.lyrics}`);
    process.stderr.write(`[researcher] lyrics: ${blocks.length}/${results.length} tracks\n`);
    if (!blocks.length) return "";
    return (
      "\n\n## Track Lyrics (VERBATIM — the ONLY source for quoting lyrics)\n\n" +
      "These are the actual lyrics. If the host quotes a lyric it MUST match one of these " +
      "word-for-word; never invent, paraphrase, or approximate a lyric.\n\n" +
      blocks.join("\n\n---\n\n")
    );
  } catch (e) {
    process.stderr.write(`[researcher] lyrics gather failed: ${String(e)}\n`);
    return "";
  }
}

export async function researchAlbum(
  album: string,
  artist: string,
  notesPath: string,
  focus?: string,
): Promise<void> {
  const queries = [
    `${album} ${artist} album making of recording`,
    `${album} ${artist} producer studio recording process`,
    `${album} ${artist} gear instruments equipment signal chain`,
    `${album} ${artist} vocal production mixing technique`,
    `${album} ${artist} track by track songwriting interview`,
  ];
  if (focus) queries.push(`${album} ${artist} ${focus}`);

  // Search each query, keeping results grouped so we can interleave them fairly.
  // (A flat first-come dedup lets query 1's hits fill the whole fetch budget, so
  // the gear/technique/track queries never get fetched — which is exactly how the
  // recording-chain detail went missing. Round-robin fixes that.)
  const perQuery: SearchResult[][] = [];
  for (const q of queries) {
    try {
      perQuery.push(await webSearch(q, PER_QUERY));
    } catch (e) {
      process.stderr.write(`[researcher] search failed (${q}): ${String(e)}\n`);
      perQuery.push([]);
    }
    await delay(1200);
  }

  // Round-robin across queries (rank 0 of every query, then rank 1, …) so each
  // topic contributes to the fetched set before we hit MAX_PAGES.
  const seen = new Set<string>();
  const hits: SearchResult[] = [];
  for (let rank = 0; rank < PER_QUERY; rank++) {
    for (const results of perQuery) {
      const r = results[rank];
      if (r?.url && !seen.has(r.url)) {
        seen.add(r.url);
        hits.push(r);
      }
    }
  }
  process.stderr.write(`[researcher] ${hits.length} unique results from ${queries.length} queries\n`);
  if (!hits.length) throw new Error("researcher found no search results (is BRAVE_API_KEY set/valid?)");

  // Fetch the top pages (polite, spaced) as source text, each tagged with a
  // reliability tier so the synthesis + fact-check can weight/quarantine claims.
  const sources: string[] = [];
  for (const h of hits.slice(0, MAX_PAGES)) {
    try {
      const text = await webFetchText(h.url, PAGE_CHARS);
      const tier = sourceReliability(h.url);
      sources.push(`### SOURCE [${tier}]: ${h.title}\nURL: ${h.url}\n\n${text}`);
    } catch (e) {
      process.stderr.write(`[researcher] fetch failed (${h.url}): ${String(e)}\n`);
    }
    await delay(1000);
  }
  process.stderr.write(`[researcher] fetched ${sources.length} page(s)\n`);
  if (!sources.length) throw new Error("researcher gathered no source pages");

  // Synthesize exhaustive notes from ONLY the gathered sources.
  const user = [
    `Album: "${album}" by ${artist}.`,
    focus ? `Focus especially on: ${focus}.` : "",
    "",
    "Synthesize EXHAUSTIVE, organised making-of research notes in markdown from the sources below.",
    "Use ONLY these sources; do not fabricate. Where sources disagree or are silent, say so.",
    "Cover: writing process; personnel (producers, engineers, session players); studios; gear and",
    "the recording chain; timeline; notable anecdotes; and scene/era context. Be specific and thorough —",
    "the Script Writer will use ONLY your notes.",
    "",
    "--- SOURCES ---",
    sources.join("\n\n---\n\n"),
  ]
    .filter(Boolean)
    .join("\n");

  const notes = await complete(RESEARCHER_SYSTEM, user, RESEARCH_MODEL);
  if (!notes.trim()) throw new Error("researcher synthesis produced no notes");

  // Fact-check the draft against the sources before it reaches the Writer.
  process.stderr.write(`[researcher] fact-checking draft (${notes.length} chars)…\n`);
  const verified = await verifyNotes(notes, sources);
  process.stderr.write(`[researcher] verified notes: ${verified.length} chars\n`);

  // Append a verbatim lyrics bank (kept out of the LLM passes so it stays exact).
  const lyrics = await gatherLyrics(album, artist);
  writeFileSync(notesPath, verified + lyrics, "utf-8");
}
