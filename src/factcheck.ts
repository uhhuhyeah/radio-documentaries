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

import { SCRIPT_FACTCHECK_SYSTEM, SCRIPT_FACTCHECK_VERIFY_SYSTEM } from "./agents/system-prompts";
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

/** A verification verdict on a first-pass finding. "SUPPORTED" means discard it. */
export type Verdict = "SUPPORTED" | "CONTRADICTION" | "UNSUPPORTED";

const VERDICTS: readonly Verdict[] = ["SUPPORTED", "CONTRADICTION", "UNSUPPORTED"];

/**
 * Parse the verification pass's `[{index, verdict}]` array into a 1-based index → verdict map.
 * Tolerant like `parseFindings` (models wrap JSON in prose); anything malformed is simply absent
 * from the map, which the caller treats as "leave this finding alone". Pure.
 */
export function parseVerdicts(reply: string): Map<number, Verdict> {
  const out = new Map<number, Verdict>();
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return out;
  let arr: unknown;
  try {
    arr = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const index = typeof o.index === "number" ? o.index : Number(o.index);
    const verdict = VERDICTS.includes(o.verdict as Verdict) ? (o.verdict as Verdict) : null;
    if (Number.isInteger(index) && verdict) out.set(index, verdict);
  }
  return out;
}

/**
 * Apply verification verdicts to the first-pass findings: drop the ones the research actually
 * supports, and re-label severity for the rest — this is what upgrades a misfiled contradiction
 * (the notes carry a competing value) out of the advisory bucket. A finding with no verdict is
 * kept UNCHANGED: a partial or unparseable verification must never silently discard findings. Pure.
 */
export function applyVerdicts(findings: ScriptFinding[], verdicts: Map<number, Verdict>): ScriptFinding[] {
  const out: ScriptFinding[] = [];
  findings.forEach((f, i) => {
    const verdict = verdicts.get(i + 1); // findings are presented to the model 1-based
    if (!verdict) {
      out.push(f); // no verdict → leave it exactly as the first pass had it
      return;
    }
    if (verdict === "SUPPORTED") return; // the research backs it — not a finding at all
    out.push(verdict === f.severity ? f : { ...f, severity: verdict });
  });
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "CONTRADICTION" ? -1 : 1));
}

/**
 * Second-pass precision check over the first pass's findings. The first pass both over-flags
 * (emitting findings whose own issue concedes the research supports the claim) and MISLABELS —
 * a flat contradiction (notes say thirteen tracks, script says twelve) filed as UNSUPPORTED lands
 * in the "advisory, don't revise" bucket and would ship unattended. This re-adjudicates each
 * finding on the one question that separates them: does the research carry a competing value?
 *
 * Fail-safe: any error, or a reply that yields no verdicts, returns the findings untouched.
 */
export async function verifyFindings(
  findings: ScriptFinding[],
  researchText: string,
  model: string = config.models.verify,
): Promise<ScriptFinding[]> {
  if (findings.length === 0) return findings;
  const list = findings
    .map((f, i) => `${i + 1}. [${f.severity}] quote: ${JSON.stringify(f.quote)}\n   issue: ${f.issue}`)
    .join("\n");
  const user = [
    "Return ONLY the JSON verdict array — one entry per finding, using its number as `index`.",
    "",
    "--- RESEARCH ---",
    researchText,
    "",
    "--- FINDINGS ---",
    list,
  ].join("\n");
  try {
    const verdicts = parseVerdicts(await complete(SCRIPT_FACTCHECK_VERIFY_SYSTEM, user, model));
    if (verdicts.size === 0) return findings; // unparseable → keep the first pass verbatim
    return applyVerdicts(findings, verdicts);
  } catch {
    return findings; // the verification is a precision improvement, never a source of data loss
  }
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
  const quoted = dropUnquotedFindings(findings, spoken);
  // Precision pass: drop what the research actually supports and re-label misfiled severities,
  // so a real contradiction can't sit in the advisory bucket. Fail-safe — returns `quoted` on error.
  return verifyFindings(quoted, researchText, model);
}

/** File wrapper for the CLI / Producer tool. */
export function factCheckFiles(scriptPath: string, researchPath: string, model?: string): Promise<ScriptFinding[]> {
  return factCheckScript(readFileSync(scriptPath, "utf-8"), readFileSync(researchPath, "utf-8"), model);
}
