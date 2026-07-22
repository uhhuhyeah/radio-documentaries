/**
 * Script fact-check — the editorial counterpart to the research fact-checker.
 *
 * The research notes are verified before the Writer sees them, but the Writer can
 * still embellish beyond them in character: swap an album title, add an invented
 * "fun fact". This pass re-reads the finished script against the research and
 * flags album/making-of claims that contradict or aren't supported — while
 * ignoring the host's persona colour, opinion, and quoted lyrics.
 *
 * Advisory, not a hard gate: an LLM judgement shouldn't silently block a render
 * the way the deterministic lint does. It surfaces findings for a human/the
 * Producer to weigh.
 */

import { readFileSync } from "node:fs";

import { SCRIPT_FACTCHECK_SYSTEM } from "./agents/system-prompts";
import { config } from "./config";
import { complete } from "./llm";
import * as sm from "./scriptmodel";

export type Severity = "CONTRADICTION" | "UNSUPPORTED";

export interface ScriptFinding {
  severity: Severity;
  /** The exact phrase from the script the finding is about. */
  quote: string;
  /** One sentence: what the research says vs. what the script claims. */
  issue: string;
}

/**
 * Extract the JSON findings array from an LLM reply, tolerantly (models wrap JSON
 * in prose or code fences). Pure — unit-tested without the network. Anything that
 * doesn't parse into well-formed findings yields [] rather than throwing.
 */
export function parseFindings(reply: string): ScriptFinding[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: ScriptFinding[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const severity = o.severity === "CONTRADICTION" || o.severity === "UNSUPPORTED" ? o.severity : null;
    const quote = typeof o.quote === "string" ? o.quote.trim() : "";
    const issue = typeof o.issue === "string" ? o.issue.trim() : "";
    if (severity && quote && issue) out.push({ severity, quote, issue });
  }
  // Contradictions (a stated fact conflicting with the notes) outrank unsupported ones.
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "CONTRADICTION" ? -1 : 1));
}

/** Fact-check a script's spoken text against research notes. Returns findings (advisory). */
export async function factCheckScript(
  scriptText: string,
  researchText: string,
  model: string = config.models.verify,
): Promise<ScriptFinding[]> {
  const ep = sm.parse(scriptText);
  const spoken = sm
    .spokenSlots(ep)
    .map((s) => `## ${s.label}\n${s.body}`)
    .join("\n\n");
  if (!spoken.trim()) return [];

  const user = [
    "Fact-check the SCRIPT against the RESEARCH. Output ONLY the JSON findings array.",
    "",
    "--- RESEARCH ---",
    researchText,
    "",
    "--- SCRIPT (spoken parts only) ---",
    spoken,
  ].join("\n");

  return parseFindings(await complete(SCRIPT_FACTCHECK_SYSTEM, user, model));
}

/** File wrapper for the CLI / Producer tool. */
export function factCheckFiles(scriptPath: string, researchPath: string, model?: string): Promise<ScriptFinding[]> {
  return factCheckScript(readFileSync(scriptPath, "utf-8"), readFileSync(researchPath, "utf-8"), model);
}
