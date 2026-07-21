/**
 * Web search + fetch for the Researcher agent — no API key.
 *
 * Search scrapes DuckDuckGo's HTML endpoint (html.duckduckgo.com/html/); fetch
 * pulls a page and reduces it to plain text. The HTML parsing is split into pure
 * functions so it's unit-tested without the network (the scrape markup is
 * brittle — if DDG changes it, `parseDdgResults` is where to fix it).
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

/** DDG result links are redirects (…/l/?uddg=<encoded target>). Unwrap them. */
export function decodeDdgHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) return decodeURIComponent(m[1]!);
  if (href.startsWith("//")) return "https:" + href;
  return href;
}

export function parseDdgResults(html: string, max = 8): SearchResult[] {
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(htmlToText(sm[1]!));

  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const out: SearchResult[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = anchorRe.exec(html)) && out.length < max) {
    out.push({ url: decodeDdgHref(m[1]!), title: htmlToText(m[2]!), snippet: snippets[i] ?? "" });
    i++;
  }
  return out;
}

// --- network -----------------------------------------------------------------

export async function webSearch(query: string, max = 8): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  return parseDdgResults(await res.text(), max);
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
  description: "Search the web (DuckDuckGo) and return titles, URLs, and snippets.",
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
