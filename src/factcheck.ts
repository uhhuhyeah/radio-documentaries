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

/** What kind of album/making-of fact the finding is about, to help downstream triage. */
export type Category = "gear" | "credit" | "date" | "history" | "other";

/** How sure the checker is. Optional — omitted when the model doesn't supply it. */
export type Confidence = "high" | "medium" | "low";

export interface ScriptFinding {
  severity: Severity;
  /** The exact phrase from the script the finding is about. */
  quote: string;
  /** One sentence: what the research says vs. what the script claims. */
  issue: string;
  /** Coarse bucket for triage. Defaults to "other" when the model omits it. */
  category: Category;
  /** Optional self-reported confidence. Absent when the model doesn't supply a valid value. */
  confidence?: Confidence;
}

const CATEGORIES: readonly Category[] = ["gear", "credit", "date", "history", "other"];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

/**
 * Normalize text for verbatim quote matching: unify smart quotes/apostrophes,
 * collapse all whitespace to single spaces, lowercase, and trim. Pure.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * Deterministic verbatim-quote guard. Drops any finding whose `quote` does NOT
 * appear (as a normalized substring) in the script's spoken text. This kills
 * hallucinated findings — the checker's real failure mode was inventing a quote
 * that was never in the script. Pure.
 */
export function dropUnquotedFindings(findings: ScriptFinding[], scriptText: string): ScriptFinding[] {
  const haystack = normalizeForMatch(scriptText);
  return findings.filter((f) => {
    const needle = normalizeForMatch(f.quote);
    return needle.length > 0 && haystack.includes(needle);
  });
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
    const category = CATEGORIES.includes(o.category as Category) ? (o.category as Category) : "other";
    const confidence = CONFIDENCES.includes(o.confidence as Confidence) ? (o.confidence as Confidence) : undefined;
    if (severity && quote && issue) {
      const finding: ScriptFinding = { severity, quote, issue, category };
      if (confidence) finding.confidence = confidence;
      out.push(finding);
    }
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

  const findings = parseFindings(await complete(SCRIPT_FACTCHECK_SYSTEM, user, model));
  // Deterministic guard: drop any finding whose quote isn't actually in the spoken script.
  return dropUnquotedFindings(findings, spoken);
}

/** File wrapper for the CLI / Producer tool. */
export function factCheckFiles(scriptPath: string, researchPath: string, model?: string): Promise<ScriptFinding[]> {
  return factCheckScript(readFileSync(scriptPath, "utf-8"), readFileSync(researchPath, "utf-8"), model);
}
