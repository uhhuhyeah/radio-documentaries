# Harness Architecture — Developer Guide

**How to build reliable LLM pipelines with Pi SDK, distilled from the SUB/WAVE radio-documentaries production harness.**

This guide walks through the architecture, code organisation, and design patterns used in this repo. It's not about the documentary domain — it's about the *harness* layer: how the deterministic TypeScript modules, the Pi agent orchestration, the sub-agent calls, the tool definitions, and the machine-verifiable contracts fit together. These lessons apply to any LLM-powered production pipeline.

## Table of Contents

1. [The Core Insight](#1-the-core-insight)
2. [Architecture Layers](#2-architecture-layers)
3. [The Tool Adapter Pattern](#3-the-tool-adapter-pattern)
4. [The Agent-as-Tool Pattern (Sub-agents)](#4-the-agent-as-tool-pattern-sub-agents)
5. [LLM Plumbing — the `complete()` Abstraction](#5-llm-plumbing-the-complete-abstraction)
6. [System Prompts as Versioned Code](#6-system-prompts-as-versioned-code)
7. [Machine-Verifiable Contracts](#7-machine-verifiable-contracts)
8. [File-as-State (No Database)](#8-file-as-state-no-database)
9. [Agent Ergonomics — Tool Description as Prompt Engineering](#9-agent-ergonomics)
10. [Error Handling Philosophy](#10-error-handling-philosophy)
11. [Testing Strategy](#11-testing-strategy)
12. [File Layout Conventions](#12-file-layout-conventions)
13. [Checklist for Building a Similar Harness](#13-checklist)

---

## 1. The Core Insight

**An LLM pipeline should minimise what the LLM touches.** Every step that can be deterministic code *should be* deterministic code with tests. The LLM is confined to the irreducible creative steps (research synthesis, script writing) behind machine-verifiable gates.

This repo's stage breakdown:

```
                    ┌─────────────────────────────────────┐
                    │         Producer Agent (Pi)          │
                    │  Orchestrates, delegates, validates  │
                    └──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┘
                       │  │  │  │  │  │  │  │  │  │  │
     ┌─────────────────┘  │  │  │  │  │  │  │  │  │  │
     ▼                    │  │  │  │  │  │  │  │  │  │
┌──────────┐              ▼  │  │  │  │  │  │  │  │  │
│ Catalog  │         ┌─────────┐ │  │  │  │  │  │  │  │  ← deterministic
│ (seasons │         │Researcher│ │  │  │  │  │  │  │  │    modules
│  .md)    │         │ (LLM)    │ │  │  │  │  │  │  │  │
└──────────┘         └─────────┘ │  │  │  │  │  │  │  │
                                 ▼  │  │  │  │  │  │  │
                            ┌────────┐ │  │  │  │  │  │
                            │ Writer │ │  │  │  │  │  │
                            │ (LLM)  │ │  │  │  │  │  │
                            └────────┘ │  │  │  │  │  │
                                       ▼  │  │  │  │  │
                                  ┌────────┐│  │  │  │  │
                                  │ Linter ││  │  │  │  │  ← machine gate
                                  └────────┘│  │  │  │  │
                                             ▼  │  │  │  │
                                        ┌────────┐│  │  │
                                        │ Budget ││  │  │
                                        └────────┘│  │  │
                                                   ▼  │  │
                                              ┌────────┐│ │
                                              │ Render ││ │
                                              └────────┘│ │
                                                         ▼ │
                                                    ┌────────┐
                                                    │Publish │
                                                    └────────┘

KEY:
  ┌─────┐ = LLM call
  ┌─────┐ = deterministic code + tests
```

**Only 2 of 10 stages need an LLM.** That's the target architecture for any LLM harness.

---

## 2. Architecture Layers

The code is organised into four distinct layers, each with a clear dependency direction:

```
┌──────────────────────────────────────────────┐
│            Pi Agent Layer                     │
│  (producer.ts, tools/index.ts, tools/*.ts)    │
│  Defines tools, creates sessions, prompts     │
├──────────────────────────────────────────────┤
│           LLM Plumbing Layer                  │
│  (llm.ts, agents/system-prompts.ts)           │
│  One-shot complete(), provider config         │
├──────────────────────────────────────────────┤
│         Deterministic Domain Modules          │
│  (scriptmodel.ts, catalog.ts, lint.ts,        │
│   budget.ts, render.ts, navidrome.ts,         │
│   elevenlabs.ts, publish.ts, qa.ts,           │
│   factcheck.ts, job-status.ts, credit.ts,     │
│   preflight.ts, stage.ts)                     │
│  Pure logic + API wrappers, fully testable    │
├──────────────────────────────────────────────┤
│         Sub-agent Implementations             │
│  (agents/researcher.ts, agents/writer.ts)     │
│  Orchestrate LLM + domain modules to produce  │
│  a specific deliverable (research.md, script) │
└──────────────────────────────────────────────┘
```

**Dependency rule:** each layer depends only on the layers below it. The Pi agent layer never imports domain modules directly — it goes through tools. Tools never call the Pi SDK — they're just exported functions.

---

## 3. The Tool Adapter Pattern

The most important structural pattern in the harness. Every deterministic domain function is surfaced to the Pi agent through a **thin tool adapter**.

### The pattern

```
┌──────────────────┐        ┌───────────────────┐        ┌──────────────────┐
│  Domain function │  ───>  │  Tool adapter      │  ───>  │  Pi Agent        │
│  (pure + tested) │        │  (defineTool +     │        │  (calls tool by  │
│                  │        │   result shaping)  │        │   name)          │
└──────────────────┘        └───────────────────┘        └──────────────────┘
```

### Concrete example

In `src/tools/index.ts`:

```typescript
// ── Domain function (src/lint.ts) ──
export function lintText(text: string): Finding[] { ... }
export function lintFile(path: string): Finding[] { ... }

// ── Tool adapter (src/tools/index.ts) ──
export const lintScriptTool = defineTool({
  name: "lint_script",
  label: "Lint script",
  description: "Validate a script.md against the format contract...",
  parameters: Type.Object({
    scriptPath: Type.String(),
  }),
  execute: async (_id, params) => {
    const findings = lint.lintFile(params.scriptPath);
    const errors = findings.filter((f) => f.level === "ERROR").length;
    const summary =
      findings.length === 0
        ? "lint: OK — no issues"
        : `lint: ${errors} error(s), ${warnings} warning(s)\n` + ...;
    return result(summary, { errors, warnings, findings });
  },
});
```

### Why this pattern?

| Concern | Where it lives |
|---|---|
| Business logic | Domain function (testable, no Pi dependency) |
| Parameter schema | `Type.Object` in the tool adapter |
| Agent-facing description | `description` string in the tool adapter |
| Return text for the LLM | In the tool adapter's `result()` call |
| Structured data for code | Second arg to `result()` — available as `details` |

### The `result()` helper

```typescript
// src/tools/util.ts
export function toolResult(summary: string, details: unknown) {
  return { content: [{ type: "text" as const, text: summary }], details };
}
```

This is Pi's `AgentToolResult` shape: `content` is what the model reads (the text summary), and `details` is structured data available programmatically (test assertions, downstream consumers). **Always provide both.**

### Registration

All tools are collected in one array — the single source of truth:

```typescript
// src/tools/index.ts
export const documentaryTools = [
  catalogNextTool,
  catalogListTool,
  catalogAssignTool,
  catalogSetStatusTool,
  researchAlbumTool,     // ← sub-agent tool — see §4
  writeScriptTool,       // ← sub-agent tool — see §4
  lintScriptTool,
  factCheckScriptTool,
  qaScriptTool,
  budgetEstimateTool,
  creditCheckTool,
  renderEpisodeTool,     // ← async background job — see §4
  waitRenderTool,
  renderStatusTool,
  stageAudioTool,
  navidromeFindAlbumTool,
  navidromeAlbumSongsTool,
  navidromeScanStatusTool,
  waitScanTool,
  navidromeCreatePlaylistTool,
  publishEpisodeTool,
];
```

### Dual-use design

Every tool-wrapped domain function is also exposed via the CLI (`src/cli.ts`). Same function, two entrypoints — the CLI for humans and smoke-testing, the tool for the agent:

```typescript
// CLI caller (src/cli.ts):
const findings = lint.lintFile(sub);

// Agent caller (src/tools/index.ts):
execute: async (_id, params) => {
  const findings = lint.lintFile(params.scriptPath);
  ...
}
```

### Lessons

1. **Never put business logic in the tool adapter.** It should be a one-liner that calls a tested domain function and shapes the result.
2. **Use `Type.Object` (TypeBox) for parameters**, not loose types. The Pi SDK infers parameter descriptions from the TypeBox schema for the model.
3. **Write the `description` field for the model, not for humans.** The model reads it to decide when to call the tool. Be specific about preconditions and side effects.
4. **Return both text and structured data.** The text is what the model reasons about; the structured data is what downstream code uses.

---

## 4. The Agent-as-Tool Pattern (Sub-agents)

When a tool needs to run an *LLM sub-task* (not just call a function), the sub-agent is wrapped as a tool. This is how the Producer delegates research and writing.

### Pattern

```typescript
// src/tools/subagents.ts
export const researchAlbumTool = defineTool({
  name: "research_album",
  label: "Research album",
  description: "Run the Researcher sub-agent to web-research...",
  parameters: Type.Object({
    album: Type.String(),
    artist: Type.String(),
    notesPath: Type.String(),
    focus: Type.Optional(Type.String()),
  }),
  execute: async (_id, p) => {
    await researchAlbum(p.album, p.artist, p.notesPath, p.focus);
    return toolResult(`research notes written to ${p.notesPath}`, { notesPath: p.notesPath });
  },
});
```

The `researchAlbum` function in `src/agents/researcher.ts` is **not** a Pi agent — it's a plain async function that calls `llm.complete()` directly with a system prompt. But from the Producer's perspective, it's just another tool:

```typescript
// src/agents/researcher.ts — deterministic sub-agent (not a Pi agent loop)
export async function researchAlbum(album, artist, notesPath, focus?) {
  // 1. Brave Search → gather results
  // 2. Fetch top pages
  // 3. LLM synthesis over the gathered text
  // 4. Append verbatim lyrics from LRCLIB
  // 5. Write file
}
```

### Two tiers of agent

| Tier | Implementation | Tool-use | When to use |
|---|---|---|---|
| **Orchestrator** (Producer) | Pi agent (`createAgentSession` + `session.prompt()`) | Has tools — calls them to accomplish a multi-step task | High-level workflow control |
| **Sub-agent** (Researcher, Writer) | Plain async function calling `llm.complete()` | No tools — one-shot LLM call with a system prompt | Single creative task that doesn't need tool use |
| **Async background job** (Render, also Research) | Detached process (`spawn` + sentinel) | No tools; status-only via `wait_*` polling | Long-running job that can outlast the MCP request timeout (render: 10+ min, research: ~5-10 min) |

### A third tier: async background jobs

Some tasks are too long to fit inside an MCP request timeout (Hermes has a 600s per-request limit). These use a **third pattern**: the tool spawns a detached background process that writes a status sentinel — a small JSON file next to the job's anchor file (`<workdir>/research.status.json` or `<workdir>/render.status.json`) — and returns immediately. A companion `wait_*` tool polls the sentinel until the job settles. The sentinel carries the job's state (`running` → `done` / `error`), the pid, and a terminal result payload.

This machinery lives in `src/job-status.ts` — a **shared async transport** parameterised by job name. Both `research_album`/`wait_research` and `render_episode`/`wait_render` use it. The verdict is a pure function (`jobPollDecision`) with a bounded timeout that returns `running` (caller re-polls) instead of throwing, so the caller never hits a hard timeout wall.

For the render, the detached runner is `src/render-runner.ts` — a standalone script invoked via `tsx` that calls the existing `renderEpisode()` function and writes the terminal sentinel. A failed spawn is caught and recorded as an `error` sentinel rather than crashing the MCP server.

```typescript
// src/tools/index.ts — async render tool (simplified)
export const renderEpisodeTool = defineTool({
  name: "render_episode",
  description: "Start rendering… spawns a detached background job…",
  execute: async (_id, params) => {
    const child = spawn("pnpm", ["exec", "tsx", "src/render-runner.ts", argsJson], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    writeJobStatus(params.scriptPath, "render", { state: "running", pid: child.pid, startedAt });
    return result(`render started (pid ${child.pid}) — poll wait_render`, { state: "started" });
  },
});
```

### Why not make the sub-agents Pi agents too?

It was tried. An early version of the Researcher was a Pi agent with search/fetch tools. The result: it fired 20 blind searches, never fetched a page, and tripped DuckDuckGo's rate limit. **Giving an agent more tools than it needs increases failure modes.** The sub-agent-as-tool pattern is:

- **Deterministic in its orchestration** — the code decides how many searches to run, with what queries, how to space them, which pages to fetch, and when to call the LLM
- **LLM-only in its synthesis** — the model's only job is to synthesise the gathered text into well-organised notes

This is the **bounded LLM** pattern: the LLM is confined to exactly the creative task it's good at, and the surrounding process is deterministic.

### Lessons

1. **Don't make a Pi agent unless the sub-task genuinely needs tool-using autonomy.** A one-shot LLM call with a good system prompt is simpler, cheaper, and more reliable.
2. **The same tool-adapter interface is used for all three tiers** — the orchestrator doesn't know or care whether the tool calls a function, runs an LLM, or spawns a background job.
3. **Sub-agent tools produce a file as their output.** This makes the pipeline resumable and debuggable: if the Writer fails, you can inspect `research.md` and re-run. Files are the communication channel between stages.
4. **Isolate the async transport from the business logic.** `job-status.ts` owns the sentinel format, poll-decision logic, and wait loop — it's pure and unit-tested. The runner (`render-runner.ts`) only calls the domain function and writes the result. Neither knows about the other's domain.

---

## 5. LLM Plumbing — the `complete()` Abstraction

The harness wraps `@earendil-works/pi-ai` in a minimal `complete()` function:

```typescript
// src/llm.ts
export async function complete(
  systemPrompt: string,
  user: string,
  modelId: string = DEFAULT_MODEL
): Promise<string>
```

### Why abstract this?

- **All sub-agents use the same plumbing** — provider config, timeout handling, response extraction live in one place
- **Timeouts are non-negotiable** — the `withTimeout` wrapper prevents hanging on a stuck model
- **The response extraction is standardised** — handles the `AssistantMessage` content block format uniformly

### Configuration chain

```
settings.toml  ──>  config.ts (loadConfig)  ──>  llm.ts (complete)
                       ▲
                       │
              env vars override (DOCS_RESEARCH_MODEL, etc.)
```

The Producer agent does **not** use `complete()`. It uses the Pi SDK directly (`createAgentSession` + `session.prompt()`), which handles its own model resolution. The sub-agents use `complete()`. This means:

- The **Producer** uses whatever model Pi resolves (configured via Pi's `models.json`)
- The **sub-agents** use models from `settings.toml` (different models for research vs. writing)

### Lessons

1. **Own the LLM abstraction.** Even a thin wrapper prevents provider lock-in and centralises retry/timeout logic.
2. **Don't hardcode the model.** Read it from config (file + env override) so you can change it without code changes.
3. **Use distinct models for different sub-tasks.** The researcher and writer use a fast 30B parameter model; the Producer uses a richer 235B model for orchestration reasoning.

---

## 6. System Prompts as Versioned Code

All system prompts live in one file (`src/agents/system-prompts.ts`) as exported `const` strings:

```typescript
export const PRODUCER_SYSTEM = `
You are the Producer for SUB/WAVE radio documentaries...
...
`.trim();

export const WRITER_SYSTEM = `
You are the Script Writer for a SUB/WAVE...
...
`.trim();

export const RESEARCHER_SYSTEM = `
You are the Researcher for a SUB/WAVE...
`.trim();

export const SCRIPT_FACTCHECK_SYSTEM = `
You are the Fact-Checker for a finished SUB/WAVE "Making Of" documentary SCRIPT...
`.trim();

export const SCRIPT_FACTCHECK_VERIFY_SYSTEM = `
You are re-adjudicating a first-pass fact-check...
`.trim();
```

Note the **verify prompt** — a second-pass precision check that re-adjudicates the first pass's findings. This two-pass pattern compensates for the fact-checker's non-determinism, upgrading misfiled contradictions and discarding false positives.

### Why this organisation

- **All prompts are version-controlled and diffable.** A PR changing a prompt is as reviewable as a code change.
- **The prompt IS code** — it defines the agent's behaviour as precisely as any function. Treating it as documentation (a separate markdown file that drifts from the code) would be a bug source.
- **Prompts reference the machine-verifiable contracts** — the Writer prompt describes the exact `script-format.md` contract the linter enforces. If the format changes, the prompt must change too, and they live in the same commit.

### The Producer prompt as a state machine + behavioural rules

The Producer's system prompt is structured as a numbered flow, plus explicit rules that encode *when not to act* as well as what to do:

```
Flow for a trigger like "Making of <album> by <artist>, <host> to host":
1. catalog_assign(...) → get the season/episode + working-dir name.
2. Create the working directory (write/bash) named exactly as returned.
3. research_album(...) → wait_research(...) until done.
4. write_script(...) — runs the Writer against ONLY those notes. It also settles LENGTH.
5. lint_script(...) — the script MUST pass (zero errors) before rendering.
6. factcheck_script(...) — REVISE SPARINGLY: only CONTRADICTIONS get a rewrite.
7. budget_estimate(...) — do not exceed the cap without approval.
8. render_episode(...) START → wait_render(...) until done.
9. catalog_set_status(..., "recorded") → stage_audio(...).
10. publish_episode(...) → catalog_set_status(..., "published").

RULES: Never revise for runtime. Never revise for UNSUPPORTED findings. Never rotate the
Navidrome password. Hosts are only Cara or Jools. Stop and report — do not guess.
```

This is a **deterministic workflow encoded as a prompt** — the steps are enumerated in order, the success criteria are explicit, and the rules cover both what to do and what *not* to do. The "never revise for X" rules are as important as the numbered steps: they prevent the model from looping on non-deterministic checks or inventing facts to reach a length target.

### Lessons

1. **Keep all system prompts in one file.** It makes the full "personality" of the system legible at a glance.
2. **Write prompts for the model, not for humans.** But keep them structured enough that a human can verify the logic.
3. **Codify the flow step-by-step** — numbered lists with clear success criteria reduce the model's ambiguity.
4. **Prompt changes are code changes** — they get the same PR review, the same testing, the same version tracking.

---

## 7. Machine-Verifiable Contracts

The harness's most important reliability pattern: **every LLM output is validated by deterministic code before it's consumed.**

### The contract chain

```
                     script.md
                    (LLM output)
                         │
                         ▼
                   ┌───────────┐
                   │  Linter   │  ← machine gate
                   │ (lint.ts) │
                   └───────────┘
                         │
                   passes?──No──→ Reject, retry or halt
                         │
                        Yes
                         │
                         ▼
                   ┌───────────┐
                   │  Parser   │  ← shared foundation
                   │(scriptmo- │
                   │  del.ts)  │
                   └───────────┘
                    /         \
                   ▼           ▼
            ┌──────────┐  ┌──────────┐
            │  Budget   │  │  Render  │
            │(budget.ts)│  │(render.ts)│
            └──────────┘  └──────────┘
```

### The script format contract

The format is specified in `script-format.md` and codified in `scriptmodel.ts` (parser) and `lint.ts` (validator). The linter checks:

- **Front matter completeness** — all required keys present, host is valid, model is known
- **Slot structure** — indices are contiguous, labels are kebab-case, SPOKEN bodies are non-empty, SONG bodies have required metadata
- **Reference track count** — declared count matches actual SONG slots
- **Duration sanity** — spoken word count doesn't exceed or fall unreasonably below the target
- **Malformed headings** — lines that look like slot headings but don't parse (typo protection)

The Writer's system prompt instructs the model to follow this format exactly. The linter then enforces it mechanically. **The linter gates rendering** — if it finds errors, the episode stops.

### The same contract philosophy — beyond format, into facts and quality

The contract pattern extends past the script format to two additional gates:

**QA (`src/qa.ts`)** — the lyric fidelity gate. Quoted lyrics are validated against a verbatim bank extracted from the research notes. Rather than a brittle substring match, the check uses **fuzzy substring similarity** (edit-distance-based) with three tiers:
- `ok` (≥0.9 similarity) — verbatim or transcription noise (spelled-out letters, stray articles); passes
- `fix` (≥0.55 similarity) — a real lyric, imperfectly quoted; flags for revision
- `unknown` (<0.55 similarity) — likely dialogue or a fabrication; flags for review

This tuning lets real-world transcription differences (LRCLIB vs. the transcript — "fuckin'"/"fucking", stray articles) pass while catching genuine misquotes. QA also enforces a wide house range (15–40 min, aim ~20) so length is an advisory guard, not a hard gate.

**Fact-check (`src/factcheck.ts`)** — a two-pass verification system. The first pass (`SCRIPT_FACTCHECK_SYSTEM`) flags claims as `CONTRADICTION` or `UNSUPPORTED`. The second pass (`SCRIPT_FACTCHECK_VERIFY_SYSTEM`) re-adjudicates each finding against the research, upgrading misfiled contradictions and dropping findings the research actually supports. The result is a reliable signal: contradictions are actionable, unsupported claims are advisory and should NOT trigger a revision.

### Why this matters

LLMs are great at creative tasks but unreliable at following structural rules. Rather than hoping the model gets it right, the harness:

1. **Describes the format precisely in the prompt** (ideally with examples)
2. **Parses the output** — if the structure is recoverable, the code handles it
3. **Validates the parsed structure** — if it's wrong, fail fast
4. **Reports what's wrong** — so the LLM can retry with targeted feedback, or the human can intervene
5. **For non-deterministic checks (fact-check, QA), use a tiered or two-pass design** — a single LLM call is unreliable; a verification pass or fuzzy threshold makes the signal actionable

### Lessons

1. **Every LLM output needs a machine-verifiable contract.** If you can't write a validator for it, you can't trust it in production.
2. **Design the contract for parsing, not for human readability.** The slot model (`## [NN] SPOKEN · label`) is designed to be regex-parsed and validatable.
3. **Fail closed.** The linter error count determines whether rendering proceeds — it doesn't warn and continue.
4. **The parser and the linter are separate concerns.** `scriptmodel.ts` parses; `lint.ts` validates. This separation makes testing easier and keeps each module focused.

---

## 8. File-as-State (No Database)

The harness uses no database. All state is in files:

| State | File | Managed by |
|---|---|---|
| Episode catalog | `seasons.md` | `catalog.ts` |
| Research notes | `<workdir>/research.md` | Researcher |
| Research job status | `<workdir>/research.status.json` | `job-status.ts` (bound by `research-status.ts`) |
| Research runner log | `<workdir>/research.log` | `research-runner.ts` |
| Script | `<workdir>/script.md` | Writer |
| QC issues | `<workdir>/qc-issues.md` | Writer |
| Render job status | `<workdir>/render.status.json` | `job-status.ts` (written by `render-runner.ts`) |
| Render runner log | `<workdir>/render.log` | `render-runner.ts` |
| Cue sheet | `<workdir>/rundown.json` | Renderer |
| Audio segments | `<workdir>/audio/*.mp3` | Renderer |
| Config | `settings.toml` + `.env` | `config.ts` |

### Why files over a database

- **Everything is human-readable and git-diffable.** You can see exactly what changed between episode iterations.
- **Zero infrastructure.** No Postgres, no SQLite, no schema migrations.
- **Resumable workflows.** The Producer checks which files exist before deciding what to do. If `research.md` exists, it can skip research.
- **Debuggable.** Inspect any stage's output by reading the file.
- **Matches the homelab philosophy.** Simple, transparent, low-maintenance.

### The catalog pattern

`seasons.md` is both human-readable documentation and machine-parseable state:

```markdown
## Season 1

| Ep | Album | Artist | Host | Status | Dir | Published |
| -- | ----- | ------ | ---- | ------ | --- | --------- |
| 01 | Punisher | Phoebe Bridgers | Cara | published | S01E01-punisher | 2026-07-21 |
```

`catalog.ts` parses this by finding the table under the right `## Season N` heading, ignoring code-fenced blocks and separator lines, and parsing each `|`-delimited row. Mutations (assigning an episode, updating status) edit the file in place.

### Lessons

1. **Files are fine until they're not.** For a single-machine, single-operator pipeline, files are simpler and more transparent than a database.
2. **Design for concurrent safety at the workflow level.** The catalog is only modified by one process at a time.
3. **Use JSON for machine-only state** (e.g. `rundown.json`) and Markdown for state that doubles as documentation (e.g. `seasons.md`).
4. **Fence-aware parsing** — `catalog.ts` ignores content inside ``` and ~~~ fences so illustrative example tables in the same file don't confuse the parser.

---

## 9. Agent Ergonomics

### Tool descriptions are prompt engineering

Every `defineTool` call includes a `description` field. This is what the model reads to decide when to call the tool. Wincingly specific descriptions are better than vague ones:

```typescript
// Good:
description: "Return the next episode number for a season (defaults to the active season)."

// Better:
description: "Claim a matching planned row or append the next episode, setting it in-production. " +
  "Returns the assigned season/episode and the working-directory name to create."
```

### Explicit parameter descriptions

Each parameter gets a `description` in the TypeBox schema. The model sees these when deciding what values to pass:

```typescript
parameters: Type.Object({
  status: Type.String(),
  published: Type.Optional(Type.String({
    description: "YYYY-MM-DD; set when publishing."
  })),
}),
```

### Tool labelling

The `label` field provides a human-readable tool name (shown in UI logs). Keep it short:

```typescript
label: "Navidrome: find album"
```

### Return shaping for the agent's reasoning

The tool's return text is what the model sees and reasons about. Structure it for the model's consumption:

```typescript
// LLM reads this:
"claimed: S01E01-punisher"

// vs. this (better):
"claimed: S01E01-punisher"

// Also include what the model needs to know for the next step:
"Season 1: next episode is 2."
```

### Lessons

1. **The tool description is the model's API documentation.** Write it as if you're writing docs for a human developer who has never seen your code.
2. **Parameter descriptions prevent hallucinated arguments.** If the model doesn't know what format a date should be in, it'll guess.
3. **Return enough context for the next step.** The Producer reads tool outputs to decide what to do next. If the catalog assign returns the working directory name, the Producer uses that to create the directory.
4. **Keep return text concise.** The model has a limited context window. Verbose tool outputs crowd out the system prompt.

---

## 10. Error Handling Philosophy

### Domain errors are typed

```typescript
export class ScriptError extends Error {}
export class SubsonicError extends Error {}
export class ElevenLabsError extends Error {}
export class CatalogError extends Error {}
```

Each domain module has its own error class. The Pi agent sees a tool fail and can decide how to handle it — retry, report, or halt.

### What the Producer prompt says about errors

```
If something is ambiguous or a tool errors, stop and report — do not guess.
```

This is critical prompt engineering. Without it, the model is likely to invent data to fill gaps or gloss over errors. The explicit instruction to "stop and report" turns errors into a halt signal rather than a hallucination trigger.

### The money gate

The budget check is a hard gate with explicit instructions:

```
do not exceed the cap without explicit approval.
```

This is one of the prompt-as-state-machine rules: a creative step (rendering, which costs money) requires an explicit approval step. The model won't proceed without it.

### Async job failure modes

The async background job pattern introduces distinct failure modes that `jobPollDecision` handles via a strict verdict precedence:

1. **Terminal error** — the runner wrote an `error` sentinel with a message (e.g. credit guard refusal). The `wait_*` tool returns `state: "error"` with the message preserved.
2. **Stale process** — the sentinel says `running` but the pid is dead (the process crashed without writing a terminal state). The verdict is `"stale"` — reported as an error, so the caller never waits forever for a dead process.
3. **Bounded timeout** — the sentinel still says `running`, the pid is alive, but the polling window has elapsed. Unlike a scan timeout, this returns `"running"` — NOT an error — because these jobs genuinely take many minutes and the caller should just call `wait_*` again.
4. **Missing sentinel** — no sentinel file exists yet. The tool keeps polling; at the timeout boundary it returns `"running"` rather than erroring.

Precedence is deliberate: a terminal state (done/error) wins over everything, so a job that settles exactly at the deadline still reports its real outcome. A dead pid under a `running` sentinel never reports "keep waiting."

### Lessons

1. **Tell the model what to do on error.** "Stop and report" is better than "be careful."
2. **Use custom error classes for domain-specific failures.** The model sees the error message and can act on it.
3. **Hard gates for expensive operations.** Budget check before rendering, lint check before publishing.
4. **Fail fast.** If a stage fails, the pipeline stops. No silent recovery that might produce bad output.
5. **For async jobs, differentiate between "still running" and "stuck."** A bounded timeout that returns `running` (re-poll) vs. `error` (stale process) is the key design decision — the verdict must be a pure function so it's testable without I/O.

---

## 11. Testing Strategy

### The testing pyramid

```
         ┌──────────┐
         │  E2E/    │  ← few: render episode with mock LLM responses
         │  Smoke   │
         ├──────────┤
         │  Tool    │  ← some: test tool adapters with mock domain
         │  Adapter │
         ├──────────┤
         │  Domain  │  ← most: pure function tests, no network, no Pi
         │  Modules │
         └──────────┘
```

### What's tested

```
src/budget.test.ts           — credit estimation from parsed scripts
src/catalog.test.ts          — reading, assigning, setting status in seasons.md
src/config.test.ts           — TOML loading with env overrides
src/factcheck.test.ts        — finding parsing, verdict parsing, applyVerdicts (verification pass)
src/job-status.test.ts       — sentinel serialization/parse round-trips, jobPollDecision verdicts
src/lint.test.ts              — every lint rule against clean/broken scripts
src/navidrome.test.ts         — Subsonic auth, response parsing, matching (pure functions)
src/qa.test.ts                — lyric fidelity (fuzzy matching tiers), station ident, reference-track spread, length house range
src/render.test.ts            — render plan, cue sheet, sanitizeForTts, TTS request shaping
src/scriptmodel.test.ts       — front matter parsing, slot parsing, malformed headings
src/tools/render.test.ts      — tool-level tests: render_status, wait_render, render_episode double-start guard
src/agents/writer.test.ts     — buildWriterMessage modes, stripSpokenMarkdown, capSongSlots, generateForLength
```

### Testing pattern

Each domain module separates pure functions from network I/O:

```typescript
// src/web.ts — pure helpers separated from network calls
export function parseBraveResults(json, max): SearchResult[] { ... }
export function htmlToText(html): string { ... }

// Test only the pure functions — no network needed
// Network calls are tested sparingly via smoke tests
```

Similarly, `src/navidrome.ts` separates `subsonicToken()`, `authParams()`, `checkResponse()`, `matchAlbum()`, `matchSong()` — all pure functions — from the `Subsonic` class that makes actual HTTP requests.

### Tests use Vitest

```bash
pnpm test           # vitest run
pnpm test:watch     # vitest
```

### Lessons

1. **Split pure logic from I/O in every module.** The pure functions are trivial to test; the I/O is tested by contract.
2. **Test the linter with clean AND broken fixtures.** The `__fixtures__` directory has both.
3. **Don't test the LLM.** Test the surrounding code — the prompt shapes, the tool adapters, the parsing and validation. The LLM's output quality is assessed by the linter and human review.
4. **Test the error paths.** What happens when a required front matter key is missing? When Navidrome returns a failure status? When the ElevenLabs key is absent?

---

## 12. File Layout Conventions

```
src/
├── agents/                  # LLM sub-agent implementations
│   ├── producer.ts          # Pi agent orchestration
│   ├── researcher.ts        # Brave Search + LLM synthesis
│   ├── writer.ts            # Research → script via LLM + length-settling, markdown stripping, song-slot capping
│   └── system-prompts.ts    # All system prompts in one versioned file
├── tools/                   # Pi tool adapters
│   ├── index.ts             # Tool registry — every deterministic tool + agent-as-tool adapters
│   ├── subagents.ts         # Sub-agent tool adapters (research_album, wait_research, write_script)
│   ├── web.ts               # Web search/fetch tools + pure helpers
│   ├── lyrics.ts            # LRCLIB lyrics fetch tool + pure helpers
│   └── util.ts              # result() helper
├── __fixtures__/            # Test fixtures
├── budget.ts                # Credit estimation (pure + file I/O)
├── catalog.ts               # seasons.md reader/mutator
├── cli.ts                   # Human-facing CLI
├── config.ts                # settings.toml loader
├── constants.ts             # Personas, credit rates, WORDS_PER_MINUTE, shared constants
├── credit.ts                # Credit balance check (ElevenLabs API)
├── elevenlabs.ts            # ElevenLabs TTS client
├── factcheck.ts             # Script fact-checking + verification pass (CONTRADICTION / UNSUPPORTED)
├── job-status.ts            # Shared async job transport: sentinel serialization, poll-decision, wait loop
├── lint.ts                  # Script validator (the primary machine gate)
├── llm.ts                   # pi-ai abstraction (complete())
├── navidrome.ts             # Subsonic API client (pure functions + Subsonic class)
├── preflight.ts             # Network preflight check (make-ability gate)
├── producer-run.ts          # Entry point for the Producer
├── publish.ts               # Navidrome playlist builder (used by publish_episode tool)
├── qa.ts                    # Quality checks: lyric fidelity (fuzzy matching), station ident, runtime, reference tracks
├── render.ts                # TTS renderer + plan/cue generation + credit hard-stop
├── render-runner.ts         # Detached background runner for async render_episode
├── research-runner.ts       # Detached background runner for async research_album
├── research-status.ts       # Thin wrapper over job-status.ts binding the "research" job name
├── scriptmodel.ts           # Script parser (shared foundation parsed by lint, budget, render, qa)
├── stage.ts                 # NAS staging (copy MP3s + trigger Navidrome rescan)
└── *.test.ts                # Co-located tests
```

### Key conventions

| Convention | Rationale |
|---|---|
| **Sub-agent implementations in `agents/`** | Separates the "what needs an LLM" from the "what's deterministic code" |
| **Tool adapters in `tools/`** | Clear boundary between Pi SDK code and domain logic |
| **Tests co-located with source** | Easy to find; one import path |
| **No `utils/` grab-bag** | Each module is named for its domain (navidrome, elevenlabs, catalog...) |
| **One system-prompts file** | All agent "personalities" are legible at once |
| **CLI is a thin dispatch** | Just argument parsing → delegates to domain functions |
| **Shared async transport in `job-status.ts`** | The sentinel format, poll-decision logic, and wait loop are pure and shared between research and render — neither runner duplicates polling infrastructure |
| **Detached runners as `*-runner.ts`** | A standalone script (invoked via `tsx`) that calls the domain function and writes the sentinel; keeps the I/O-heavy spawn logic out of the tool adapter |

---

## 13. Checklist for Building a Similar Harness

### Architecture decisions

- [ ] **Identify the irreducible LLM steps.** What genuinely requires an LLM? Everything else should be deterministic code with tests.
- [ ] **Define the contract.** What does each LLM step produce? Can it be parsed and validated mechanically?
- [ ] **Choose file-as-state or database.** For single-operator pipelines, files are simpler.
- [ ] **Design the tool surface.** What deterministic functions does the orchestrating agent need? Each becomes a `defineTool`.

### Implementation order

1. **Domain modules first** — pure functions, no Pi dependency, fully tested
2. **Test fixtures** — the contracts the LLM must satisfy (clean + broken inputs)
3. **Linter/validator** — the machine gate that asserts the contract
4. **LLM plumbing** — the `complete()` abstraction
5. **Async job infrastructure** (if needed) — shared sentinel format, poll-decision logic, wait loop (`job-status.ts`)
6. **Sub-agent implementations** — the LLM calls behind a deterministic orchestration layer
7. **Tool adapters** — thin wrappers over domain functions (synchronous) and detached runners (async)
8. **Agent system prompt** — the orchestrator's personality, workflow, and error rules
9. **CLI** — human entrypoint for each tool (smoke-testing and debugging)
10. **Producer entrypoint** — `createAgentSession` + tools + prompt

### Questions to answer for each tool

- [ ] What is its exact name? (`snake_case` — Pi convention)
- [ ] What is its short label? (shown in UI logs)
- [ ] What does the description say? (the model reads this)
- [ ] What parameters does it take? (TypeBox schema with descriptions)
- [ ] What does it return? (text summary for the model + structured `details`)
- [ ] Does it have side effects? (file writes, network calls, money spent)
- [ ] Is the underlying function already tested?
- [ ] **Is it synchronous or async?** If it can outlast the MCP request timeout, design a start + poll + sentinel pattern with a shared `job-status.ts` transport

### Questions to answer for the agent prompt

- [ ] What is the numbered step-by-step workflow?
- [ ] What constitutes success for each step?
- [ ] What should the agent do on error? ("stop and report" vs. "retry")
- [ ] What is explicitly forbidden? ("never invent facts," "hosts are only Cara or Jools")
- [ ] What requires approval before proceeding? (credit spend, publishing)
- [ ] What context needs to be passed between steps?

### Integration tests

- [ ] Can the CLI call each tool directly?
- [ ] Does the linter catch all the broken fixture cases?
- [ ] Can the Producer prompt be run against the tools in a dry-run mode?
- [ ] Is the budget gate enforceable? (test with a cap below the estimate)
- [ ] What happens when network-dependent tools fail (Navidrome down, ElevenLabs unreachable)?

---

## Appendix: Key Files Reference

| File | Role |
|---|---|
| `src/producer.ts` | Pi agent session creation — the orchestrator's runtime |
| `src/tools/index.ts` | Tool registry — the complete list of what the agent can do (now 21 tools) |
| `src/tools/subagents.ts` | Sub-agent tool adapters — agent-as-tool + async background jobs |
| `src/llm.ts` | One-shot LLM abstraction used by all sub-agents |
| `src/agents/system-prompts.ts` | All prompts in one versioned file (Producer, Writer, Researcher, Fact-checker, Verify) |
| `src/lint.ts` | The most important machine gate — script format validation |
| `src/scriptmodel.ts` | The parser that the entire pipeline depends on |
| `src/catalog.ts` | Fence-aware markdown table parser — a useful pattern |
| `src/factcheck.ts` | Two-pass fact-checking: first pass finds contradictions, verification pass re-adjudicates severities |
| `src/job-status.ts` | Shared async job transport: sentinel serialization, poll-decision logic (`jobPollDecision`), `waitForJob` loop — used by both research and render |
| `src/qa.ts` | Quality checks: fuzzy lyric matching (3 tiers), station ident, runtime house range, reference-track spread |
| `src/render-runner.ts` | Detached background process for async ElevenLabs render — writes `render.status.json` sentinel |
| `src/research-status.ts` | Thin wrapper over `job-status.ts` binding the `"research"` job name |
| `producer-guide.md` | The design document that preceded the code |
| `script-format.md` | The contract specification |
