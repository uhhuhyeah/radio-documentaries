/**
 * Web search + fetch for the Researcher.
 *
 * Search uses the **Brave Search API** (needs BRAVE_API_KEY; free tier) — a real
 * API built for automation, so no scraping / IP-block games. Fetch pulls a page
 * and reduces it to plain text. Response parsing is split into pure functions
 * so it's unit-tested without the network.
 */

import { Type } from "typebox";

import { defineTool } from "@earendil-works/pi-coding-agent";

import { toolResult } from "./util";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// --- pure helpers ------------------------------------------------------------

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseBraveResults(json: any, max = 8): SearchResult[] {
  const results = json?.web?.results;
  if (!Array.isArray(results)) return [];
  return results.slice(0, max).map((r: any) => ({
    title: htmlToText(String(r?.title ?? "")),
    url: String(r?.url ?? ""),
    snippet: htmlToText(String(r?.description ?? "")),
  }));
}

// --- network -----------------------------------------------------------------

export async function webSearch(query: string, max = 8): Promise<SearchResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("BRAVE_API_KEY not set (see .env.example)");
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brave search ${res.status}: ${detail.slice(0, 200)}`);
  }
  return parseBraveResults(await res.json(), max);
}

export async function webFetchText(url: string, maxChars = 8000): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  const text = htmlToText(await res.text());
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
}

// --- tools -------------------------------------------------------------------

export const webSearchTool = defineTool({
  name: "web_search",
  label: "Web search",
  description: "Search the web (Brave Search API) and return titles, URLs, and snippets.",
  parameters: Type.Object({
    query: Type.String(),
    max: Type.Optional(Type.Integer({ description: "Max results (default 8)." })),
  }),
  execute: async (_id, p) => {
    const results = await webSearch(p.query, p.max ?? 8);
    const text = results.length
      ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n")
      : "(no results)";
    return toolResult(text, { results });
  },
});

export const webFetchTool = defineTool({
  name: "web_fetch",
  label: "Web fetch",
  description: "Fetch a URL and return its readable text (HTML stripped, truncated).",
  parameters: Type.Object({
    url: Type.String(),
    maxChars: Type.Optional(Type.Integer({ description: "Truncate to this many chars (default 8000)." })),
  }),
  execute: async (_id, p) => {
    const text = await webFetchText(p.url, p.maxChars ?? 8000);
    return toolResult(text, { url: p.url, chars: text.length });
  },
});
