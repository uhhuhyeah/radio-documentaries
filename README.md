# SUB/WAVE Radio Documentaries

**LLM-powered "making of" album documentaries** — an automated production pipeline that researches, scripts, voices (via ElevenLabs TTS), and publishes radio-show-style episodes into a self-hosted [Navidrome](https://www.navidrome.org/) music library.

Part of the [SUB/WAVE](https://github.com/uhhuhyeah/subwave-config) homelab AI-DJ ecosystem. Each episode is a deep dive into a single album, presented in-character by one of the station's DJ personas (Cara or Jools), with 3–5 full-length reference tracks from the album interleaved throughout — just like a real radio documentary.

## Overview

The pipeline is orchestrated by a **Producer AI agent** (built on [Pi](https://github.com/earendil-works/pi-coding-agent)) that coordinates two deterministic LLM sub-agents — a **Researcher** and a **Script Writer** — then runs a series of machine-verified, non-LLM tools to lint, budget, render TTS audio, and publish to Navidrome.

The key architectural insight: **only research and writing need an LLM.** Everything else — catalog management, script validation, credit budgeting, audio rendering via ElevenLabs, ID3 tagging, Navidrome Subsonic API calls — is deterministic TypeScript code with tests.

### High-level flow

```
Trigger (album + artist + host)
  │
  ├─ 1. Catalog assign — claim or append episode in seasons.md
  ├─ 2. Working directory created
  ├─ 3. Researcher — Brave Search + page fetch → synthesis via LLM
  ├─ 4. Writer — LLM turns research into formatted script in persona
  ├─ 5. Lint — machine-validate script format and correctness
  ├─ 6. Budget — estimate ElevenLabs credit cost
  ├─ 7. Render — ElevenLabs TTS → tagged MP3 segments + cue sheet
  ├─ (7a. Manual: move MP3s to NAS → Navidrome rescan)
  └─ 8. Publish — resolve Subsonic IDs → create Navidrome playlist
```

## Repository Structure

```
radio-documentaries/
├── src/                        # TypeScript source
│   ├── cli.ts                  # Human-facing CLI (pnpm cli ...)
│   ├── producer-run.ts         # Producer agent entrypoint (pnpm producer ...)
│   ├── config.ts               # settings.toml loader
│   ├── constants.ts            # Shared constants (personas, credit rates)
│   ├── llm.ts                  # pi-ai LLM plumbing (OpenRouter)
│   ├── scriptmodel.ts          # Script parser (front matter + slot model)
│   ├── catalog.ts              # seasons.md reader/mutator
│   ├── lint.ts                 # Script format validation
│   ├── budget.ts               # Credit cost estimation
│   ├── render.ts               # ElevenLabs TTS + ID3 tagging + cue sheet
│   ├── publish.ts              # Navidrome playlist builder
│   ├── navidrome.ts            # Subsonic API client for Navidrome
│   ├── elevenlabs.ts           # ElevenLabs TTS client
│   ├── agents/
│   │   ├── system-prompts.ts   # Agent system prompts (Producer, Writer, Researcher)
│   │   ├── producer.ts         # Pi-agent-based Producer orchestrator
│   │   ├── researcher.ts       # Brave Search + LLM synthesis → research notes
│   │   └── writer.ts           # Research → formatted script via LLM
│   ├── tools/
│   │   ├── index.ts            # Tool registry (all tools the Producer can call)
│   │   ├── subagents.ts        # Research/write as Pi agent tools
│   │   ├── web.ts              # Brave Search API + HTML-to-text fetch
│   │   ├── lyrics.ts           # LRCLIB verbatim lyric fetcher
│   │   └── util.ts             # Pi AgentToolResult helper
│   └── __fixtures__/           # Test fixtures (clean/broken scripts)
├── examples/                   # Curated sample output (a produced script.md)
├── pipeline/                   # (reserved for future Python port)
├── settings.toml               # Central config — models, voices, TTS model
├── seasons.example.md          # Episode-catalog template — copy to seasons.md
├── script-format.md            # Script format specification (the contract)
├── producer-guide.md           # Complete production guide & design document
├── package.json
├── tsconfig.json
├── LICENSE                     # MIT
└── .env.example                # Required environment variables
```

### Local-only artifacts (not in git)

The pipeline generates content that is deliberately kept out of version control — this
repo is about the **harness**, not the documentaries it happens to produce:

- **`S{season}E{episode}-<slug>/`** — per-episode working directories holding the
  generated `research.md`, `script.md`, `rundown.json`, and `audio/`. Ignored via
  `S[0-9][0-9]E[0-9][0-9]-*/`.
- **`seasons.md`** — your live catalog. Like `.env`, it's git-ignored and seeded from
  `seasons.example.md`.

A single curated `script.md` lives in `examples/` so readers can see the output format
without the full generated corpus being committed.

## Prerequisites

- **Node.js 22+** with `pnpm`
- **OpenRouter API key** — for the LLM agents (research, writing, production orchestration)
- **Brave Search API key** — for the Researcher (free tier: ~2,000 queries/month)
- **ElevenLabs API key** — for TTS rendering (a dedicated docs key is recommended, separate from the live station's key)
- **Navidrome instance** — with a music library containing the albums you want to document
- `.env` file in the project root (see `.env.example`)

## Setup

```bash
pnpm install
cp .env.example .env
# Fill in NAVIDROME_URL, NAVIDROME_USER, NAVIDROME_PASS,
# ELEVENLABS_API_KEY, OPENROUTER_API_KEY, BRAVE_API_KEY
cp seasons.example.md seasons.md   # your local episode catalog (git-ignored)
```

## Configuration

Model choices, voice IDs, speeds, and TTS engine live in **`settings.toml`** — the single place to change them:

```toml
[models]
research = "qwen/qwen3-30b-a3b-instruct-2507"    # fast research synthesis
write    = "qwen/qwen3-30b-a3b-instruct-2507"     # fast script writing
producer = "qwen/qwen3-235b-a22b-2507"            # richer model for orchestration
timeout_ms = 300000

[elevenlabs]
model = "eleven_flash_v2_5"                       # default TTS model

[voices.p_cara]
voice_id = "ZF6FPAbjXT4488VcRRnw"                 # "Amelia" — Cara's voice
speed = 1.1

[voices.p_jools]
voice_id = "1BUhH8aaMvGMUdGAmWVM"                 # "Alyx" — Jools's voice
speed = 1.0
```

Environment variables (`DOCS_RESEARCH_MODEL`, `DOCS_WRITE_MODEL`, `DOCS_PRODUCER_MODEL`, `DOCS_LLM_TIMEOUT_MS`) override the corresponding `settings.toml` values when set.

## Usage

### Automated (Producer agent)

The Producer agent orchestrates the full pipeline from trigger to published episode:

```bash
pnpm producer "Making of Punisher by Phoebe Bridgers, Cara to host"
```

The Producer will:
1. Assign a season/episode number from `seasons.md`
2. Create the working directory
3. Task the Researcher to gather research notes
4. Task the Writer to produce a formatted script
5. Lint the script (enforce the format contract)
6. Estimate the ElevenLabs credit budget
7. (On approval) Render the spoken segments to tagged MP3s
8. Wait for the manual NAS move, then build the Navidrome playlist

### Manual CLI

Each stage is also available as a standalone CLI command:

```bash
# Episode catalog management
pnpm cli catalog next                            # Next episode number
pnpm cli catalog list                            # List episodes in active season
pnpm cli catalog assign --album "Punisher" --artist "Phoebe Bridgers" --host Jools

# Research and writing
pnpm cli research --album "Punisher" --artist "Phoebe Bridgers" --out research.md
pnpm cli write --research research.md --out script.md --album "Punisher" --artist "Phoebe Bridgers" --host p_jools --host-name Jools --season 1 --episode 1

# Quality control
pnpm cli lint path/to/script.md                  # Validate script format
pnpm cli budget path/to/script.md --cap 15000    # Estimate credit cost

# TTS rendering
pnpm cli render path/to/script.md                # Produce MP3 segments
pnpm cli render path/to/script.md --only part-1  # Render one segment
pnpm cli render path/to/script.md --max-spoken 2 # Sample: first 2 spoken segments

# Navidrome operations
pnpm cli navidrome ping
pnpm cli navidrome find-album --album "Punisher"
pnpm cli navidrome album-songs --id <albumId>
pnpm cli navidrome scan-status
pnpm cli navidrome scan

# Publishing
pnpm cli publish path/to/rundown.json            # Build Navidrome playlist

# Other
pnpm cli config                                  # Print resolved config
pnpm cli llm-check                               # Verify LLM connectivity
pnpm cli web-search "punisher making of"         # Direct web search
pnpm cli lyrics --album "Punisher" --artist "Phoebe Bridgers"  # Fetch verbatim lyrics
```

## Script Format

The `script.md` file is the core contract. Every episode script follows a strict format that is machine-parseable and directly drives rendering and publishing.

```markdown
---
season: 1
episode: 1
album: "Punisher"
artist: "Phoebe Bridgers"
host: p_jools
host_name: "Jools"
model: eleven_flash_v2_5
target_minutes: 25
reference_tracks: 2
---

## [01] SPOKEN · intro
Spoken text here — the exact words to be spoken, in clean prose.

## [02] SPOKEN · part-1
More spoken content...

## [03] SONG · song-1
- title: "Kyoto"
- artist: "Phoebe Bridgers"
- album: "Punisher"
- note: play in full

## [04] SPOKEN · conclusion
Final spoken content.
```

Key rules:
- **SPOKEN** slots contain verbatim TTS text — no markdown, no stage directions
- **SONG** slots are metadata-only — they play from Navidrome, not TTS
- Slot indices are **contiguous across both types** (01, 02, 03, ...)
- Labels are **kebab-case**
- The Writer uses **only** the research notes — no web access, no guessing

See [`script-format.md`](./script-format.md) for the full specification.

## Personas

Two SUB/WAVE DJ personas host documentaries:

| Persona | ID | Voice | Style |
|---|---|---|---|
| **Cara** | `p_cara` | "Amelia" (speed 1.1) | Bubbly British it-girl; witty, gossipy, ironic pop-party host. Best for pop/celebrity-adjacent records. |
| **Jools** | `p_jools` | "Alyx" (speed 1.0) | British music obsessive; earnest, grounded, liner-note-obsessed sherpa. Best for album deep-dives where craft and context matter. |

## Episode Catalog

Episodes are tracked in `seasons.md` (a local artifact, seeded from [`seasons.example.md`](./seasons.example.md)) — a markdown table that serves as the authoritative index:

| Ep | Album | Artist | Host | Status | Dir | Published |
| -- | ----- | ------ | ---- | ------ | --- | --------- |
| 01 | Punisher | Phoebe Bridgers | Cara | published | S01E01-punisher | 2026-07-21 |

Status lifecycle: `planned` → `in-production` → `recorded` → `published`

## Navidrome Integration

The pipeline integrates with Navidrome via its [Subsonic API](http://www.subsonic.org/pages/api.jsp):
- **Read-only** for the agent (the music mount is `ro` on the homelab LXC)
- Episode MP3s are ID3-tagged and delivered to the working directory; David manually moves them to the NAS
- After a rescan, the agent resolves Subsonic IDs and creates the playlist in exact cue order

See [`producer-guide.md`](./producer-guide.md#navidrome) for full details.

## ElevenLabs Budget

A 20–30 minute episode costs approximately **9,000–12,000 credits** at Flash v2.5 rates (~0.5 credits/character), against a 30,000/month shared plan. The budget module estimates and gates this before rendering:

```bash
pnpm cli budget script.md --cap 15000
```

## Development

```bash
pnpm typecheck          # TypeScript type checking
pnpm test               # Run all tests (Vitest)
pnpm test:watch         # Watch mode
```

The codebase is thoroughly tested — every deterministic module has unit tests, and the pipeline design ensures LLM outputs are machine-verified before proceeding to the next stage.

## Design Philosophy

- **Deterministic by default, LLM by exception** — only research and writing need an LLM. Everything else is tested TypeScript.
- **Machine-verifiable contracts** — the script format (`script-format.md`) is designed to be parsed and validated programmatically. The linter gates the Writer's output.
- **Human-in-the-loop** — the NAS move is deliberately manual (the Navidrome music mount is read-only). The pipeline pauses at that seam and resumes on the next command.
- **Resumable** — each stage checks what's already done before proceeding.
- **Credit-aware** — ElevenLabs TTS is the most expensive resource; the budget gate prevents runaway spend.

## Planned Evolution

- **Monthly automation** — cron-triggered production that pops the next `planned` row from `seasons.md`
- **QC refinement** — automated quality checks beyond format linting
- **Python pipeline** — a future port for the render/publish stages (early work in `pipeline/`)

## Related Projects

- [SUB/WAVE](https://github.com/uhhuhyeah/subwave-config) — the AI-DJ station these documentaries air on
- [Pi](https://github.com/earendil-works/pi-coding-agent) — the agent framework used for orchestration
