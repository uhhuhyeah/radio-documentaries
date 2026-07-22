# SUB/WAVE Documentaries — Autonomy Plan (Hermes-orchestrated)

*Drafted 2026-07-21, after S01E01 (Punisher / Cara) and S01E02 (With Teeth / Jools) were
produced end-to-end by hand. This is the roadmap for handing the pipeline to **Hermes** — an
LLM orchestrator that runs the show on a schedule or on demand, doing the judgment work behind
deterministic guardrails.*

## How to use this doc

Each **work package** (T0-1, T1-2, …) is scoped to be knocked out in its own Claude session.
A package lists: **Goal**, **Why now** (grounded in what actually bit us), **Build** (real files
to touch), **Guardrail vs. judgment** (what must be deterministic code vs. what Hermes decides),
**Acceptance**, **Depends on**, **Open questions**. Start a session with "implement T1-1 from
`autonomy-plan.md`" and it has what it needs. The **Work-package index** near the bottom is the
pick-list; **Open questions for David** collects the decisions only you can make.

Guiding principle throughout: **deterministic code owns the hard limits (money, preconditions,
idempotency); Hermes owns judgment (fact-check triage, retry-vs-proceed, phrasing) but operates
inside those limits; a human approves the irreversible/costly steps until confidence is earned.**

---

## Decisions & environment (resolved 2026-07-21)

These answers (from David) are settled and should be assumed by every work package below.

**Orchestration & policy**

| # | Decision |
|---|----------|
| Interface (Q1) | **MCP server** — expose the existing `documentaryTools` over MCP; Hermes connects to it as a toolset. |
| Approval gate (Q4) | **Hold-before-render for Phase 0** (intermediary), **full-auto-within-budget as the destination**. Rollout = supervised → bounded → scheduled, exactly as below. |
| Fact-check (Q6) | **Block on `CONTRADICTION`** (retry `write`, then hold if unresolved); **triage `UNSUPPORTED`** (Hermes judges; it's noisy/overreach-prone). |
| Models (Q7) | **All `qwen3-235b` for now** (proven on E01/E02). Revisit only if volume makes cost/latency hurt. |
| Volume / budget (Q3) | **1 episode / month.** At ~9k credits/episode that's trivially inside the 27k key cap + rollover, so **no complex monthly ceiling is needed** — the guardrail is just a per-run credit preflight. **Auto-proceed criteria (David's bar):** script word-count in bounds **and** the key has enough credits → Hermes may proceed. (I'd add three more automated gates that are already cheap: `lint` passes, lyric-fidelity holds, and no fact-check `CONTRADICTION`; plus the make-ability preflight — album in Navidrome + lyrics resolve.) |
| Notifications (Q5) | **Telegram** — Hermes already has it. This collapses T2-4 (human-in-the-loop) and T3-2 (alerting): Hermes messages David on Telegram to hold/approve/report, and David replies to approve. No ntfy/email/Slack needed. |

**The environment (from the Brookgrass homelab vault + `subwave-config`)**

- **Hermes** = Nous Research `hermes-agent` (wraps Codex/`gpt-5.5`), running in **Proxmox LXC CTID 105** (`hermes`, `192.168.1.88`), Debian 12, **unprivileged**, non-root user `hermes` (uid 1000), 2 vCPU / 4 GB / 20 GB. Its `terminal` tool runs **locally inside the container**. Behaviour/toolsets in `~/.hermes/config.yaml`; secrets (incl. Telegram token) in `~/.hermes/.env`. Reachable only via the Proxmox host: `ssh -t root@192.168.1.10 'pct exec 105 -- su - hermes'`. Supports `worktree: true` per session. Treated as **disposable/experiment**, excluded from backups.
- **Proxmox host** = Dell OptiPlex 7090, `192.168.1.10` (LAN) / `100.110.0.9` (tailnet — this is the host `stage.ts` already SSHes to). `pve01` subnet-routes `192.168.1.0/24` over Tailscale, which is why the Mac reaches Navidrome and the NAS today.
- **Navidrome** = LXC **CTID 106** (`192.168.1.110:4533`), Subsonic API, hourly rescans, admin `david`. Docs live at `/mnt/music/subwave-documentaries/` (its view). ⚠️ **Never rotate the `david` password** — it fans out to SUB/WAVE (LXC 107) + Homepage (LXC 103).
- **The NAS** = Synology `192.168.1.93:/volume1/Music`, mounted on the **Proxmox host** at `/mnt/nas/music`. Bind-mounted **read-only** into Navidrome (`mp0 … ro=1`) but **read-write into the Jellyfin LXC**. `stage.ts` currently writes by SSHing to a host with the r/w mount (`root@100.110.0.9` = the Proxmox host) and dropping files in `/mnt/nas/music/subwave-documentaries/`; Navidrome sees them r/o and indexes on rescan.
- **Secrets provisioning:** David already provisions `.env` into LXCs from his machine (the `subwave-config` pattern). The pipeline LXC's `.env` gets the same treatment — reuse it, don't invent a vault.

**What this implies for the build (recommended shape)**

- **Where it runs:** a **dedicated pipeline LXC** on `pve01` (its own `.env`, its own NAS access), running the T0-1 **MCP server**. Hermes (CTID 105) connects to it as an MCP toolset over the LAN. This keeps the pipeline off the disposable Hermes container and off the sleeping Mac. David's accepted middle-ground — "trigger it, walk away, an hour later it's on Navidrome" — is satisfied by a **Telegram-triggered** run (no strict 3am cron required for Phase 0/1); a real schedule is a later add (T3-4).
- **NAS write path — the "digging" (feeds T0-3 / T1-5), three options:**
  - **A. SSH to a r/w-mount host (what `stage.ts` does now).** Zero mount work, already proven. But an LXC holding *root* SSH to the Proxmox host weakens the unprivileged-sandbox model; prefer SSHing to the **Jellyfin LXC** (non-root, has the r/w mount) over the host.
  - **B. Bind-mount the Synology Music share r/w into the pipeline LXC** (mirror how Jellyfin is set up). Cleanest — `stage.ts` becomes a local copy, no SSH hop — but needs the unprivileged-LXC **uid-mapping** work to get real r/w. This is the "digging" David flagged.
  - **Recommendation:** ship Phase 0 on **A (Jellyfin-LXC SSH)** to avoid blocking on mount work; treat **B** as the clean follow-up. Either way `stage --replace` + idempotent publish already handle re-runs.

---

## Current state — what's already done

The **mechanical** pipeline is ~80–90% there. Both episodes shipped as a linear chain of CLI
commands; a script (or Hermes) could drive that chain today.

Solid foundations to build on:

- **Deterministic, unit-tested tools** for the load-bearing steps — `catalog`, `lint`, `budget`,
  render-planning (`planEpisode`), `publish`, `stage` (`stageDest`). 123 tests green.
- **A catalog state machine** in `seasons.md`: `planned → in-production → recorded → published`
  — the natural spine for tracking and resuming runs.
- **An orchestrator already exists in spirit**: `PRODUCER_SYSTEM` (`src/agents/system-prompts.ts`)
  documents the flow; the CLI chains cleanly; `publish` is idempotent (drops + recreates the
  same-named playlist); `stage --replace` mirrors the NAS. Config-driven via `settings.toml` + env.
- **A working research→verify→write→lint→factcheck→budget→render→stage→rescan→publish→status**
  path, proven on two episodes and two hosts.

What's missing is the **safety** and **judgment** layer that turns "it worked while I watched" into
"it won't burn credits or publish garbage while I don't." Everything below came from a real failure
or manual intervention this session.

---

## Target architecture

```
                 schedule / "make the next episode"
                              │
                              ▼
                 ┌───────────────────────────┐
                 │   HERMES (LLM orchestrator)│  judgment: triage findings,
                 │   PRODUCER playbook        │  retry-vs-proceed, escalate
                 └─────────────┬─────────────┘
                               │ calls tools / checkpoints for approval
                               ▼
        ┌──────────────────────────────────────────────────┐
        │   PIPELINE (this repo) — deterministic substrate   │
        │   guardrails Hermes CANNOT override:               │
        │   • credit preflight + budget hard-stop            │
        │   • make-ability preconditions (album, lyrics)     │
        │   • idempotent, resumable steps + run ledger       │
        │   tools: research verify write lint factcheck      │
        │          budget render stage rescan publish status │
        └───────────────┬───────────────────┬───────────────┘
                        │                   │
                        ▼                   ▼
              OpenRouter / Brave     ElevenLabs / NAS(SSH) / Navidrome
              / LRCLIB (make)        (money + outward side effects)
```

Hermes is the smart layer. The pipeline is a **safe substrate**: it refuses to do the expensive or
irreversible thing when a hard limit says no, regardless of what Hermes "decides." Human approval
sits on the money/quality gates until each is trusted to run unattended.

---

## Foundation (Tier 0) — orchestration interface & run model

Before Hermes can drive anything, we need a clean surface for it to call and a notion of a "run."

### T0-1 — Pipeline surface for Hermes (recommend: MCP server)
- **Goal:** a stable interface Hermes (Desktop and the Proxmox LXC instance) can call to run steps
  and read state.
- **Why now:** `documentaryTools` in `src/tools/index.ts` already wraps every step as a
  `defineTool`. The cheapest path to Hermes-callable is to expose those over **MCP**. Alternatives:
  Hermes shells the `docuflow` CLI (simplest, least structured), or a thin HTTP service.
- **Build:** an MCP server entrypoint (`src/mcp.ts` / `pnpm mcp`) that registers the existing tools
  plus the Tier-1 guardrail ops (preflight, credit-check, run-status). Reuse the `defineTool`
  definitions; don't fork logic.
- **Guardrail vs. judgment:** interface only. The tools it exposes carry the guardrails.
- **Acceptance:** Hermes Desktop can list + call the pipeline tools; a dry "assign → research"
  works over MCP.
- **Depends on:** none.
- **Open questions:** MCP vs. CLI-shell vs. HTTP? (see Open questions for David #1).

### T0-2 — Run ledger & idempotency state
- **Goal:** a per-episode run record so any run is inspectable and resumable, and Hermes can reason
  about "where am I?"
- **Why now:** this session I tracked step completion, cost, and decisions in my head. Unattended,
  that state has to live somewhere. The catalog already tracks coarse status; a run needs finer
  grain (which segments rendered, credits spent, findings, decisions).
- **Build:** a `run.json` in the workdir (or `runs/SxxEyy-*.json`) capturing per-step status,
  timestamps, cost, fact-check findings + dispositions, and the last safe checkpoint. Written by
  each step; read on resume. Ties into the catalog state machine (don't duplicate it — extend).
- **Guardrail vs. judgment:** deterministic ledger; Hermes reads/annotates.
- **Acceptance:** killing a run mid-flow and re-invoking resumes from the ledger, not from scratch.
- **Depends on:** informs T1-2, T1-5, T3-1.

### T0-3 — Deployment & secrets topology
- **Goal:** decide **where the pipeline executes** relative to Hermes Desktop, the Hermes LXC, the
  Navidrome LXC, and the NAS — and how secrets/reachability work there.
- **Why now:** the pipeline currently runs on this Mac, which holds `.env` (Brave/OpenRouter/
  ElevenLabs/Navidrome), SSH access to the NAS host `root@100.110.0.9`, and reaches Navidrome at
  `192.168.1.110`. If Hermes-in-LXC orchestrates, it needs the code, those keys, NAS SSH, and
  Navidrome network access. This is a decision + a small amount of plumbing, not a big build.
- **Build:** a short deployment note + whatever runner/secret wiring the chosen topology needs
  (e.g., pipeline runs as the MCP server on the Mac and both Hermes instances connect; or pipeline
  is deployed into the Hermes LXC with its own `.env` + NAS key).
- **Acceptance:** the chosen Hermes instance can complete a full dry run against real services.
- **Open questions:** Open questions for David #2.

---

## Tier 1 — Safety substrate (deterministic hard guardrails)

These are the things that make unattended runs *safe*. Hermes cannot override them.

### T1-1 — Credit preflight + budget hard-stop
- **Goal:** never start a render that can't finish; never exceed a spend ceiling.
- **Why now:** **the S01E02 render hit `quota_exceeded` mid-way** — it rendered ~3 of 9 segments,
  drawing the ElevenLabs "Documentaries" key to 179 credits, then failed, leaving a partial episode
  with no rundown. A preflight would have caught this before spending a credit.
- **Build:** before `render`, query the ElevenLabs key balance (subscription endpoint) and compare
  to `budget_estimate`; **abort with a clear reason if balance < required** (no partial renders).
  Add per-run and per-month credit ceilings to `settings.toml` (`[budget] per_episode_cap`,
  `monthly_cap`); `render`/the orchestrator refuse past them. Consider recording spend to the run
  ledger (T0-2) to enforce `monthly_cap` across episodes.
- **Guardrail vs. judgment:** hard guardrail. Hermes may *ask* to render; the substrate says no if
  the numbers don't clear.
- **Acceptance:** with an under-funded key, `render` refuses up front and writes nothing; with a
  cap set below estimate, it refuses.
- **Depends on:** ties to T1-2 (resume) and T3-5 (usage tracking).

### T1-2 — Render resume / partial-state recovery
- **Goal:** a render interrupted by quota/network/crash resumes instead of re-charging everything.
- **Why now:** the partial S01E02 render left 3 good segments that a full re-render re-paid for.
  `renderEpisode` already supports `--skip-spoken`/`--only`; we just need safe detection + resume.
- **Build:** have `render` write a manifest (or use the run ledger) of completed segments; on
  re-invoke, detect the delta against the plan and render only what's missing, then write the full
  `rundown.json`. Verify each existing file is complete (not truncated) before trusting it.
- **Guardrail vs. judgment:** deterministic. Hermes chooses resume-vs-clean-retry via policy.
- **Acceptance:** kill render after N segments; re-run renders only the remaining ones and produces
  a valid rundown.
- **Depends on:** T0-2.

### T1-3 — Make-ability preconditions (preflight gates)
- **Goal:** fail fast, before spending research/render effort, when an episode can't be made well.
- **Why now:** I manually preflighted every episode — *is the album in Navidrome?* (publish needs
  its reference tracks) and *do lyrics resolve?* Recall the **transient 0/10 lyrics** on scratch
  runs: unattended, that ships a lyric-less, short episode. An album missing from the library can't
  be published at all.
- **Build:** a `preflight` command/tool that checks: album resolvable in Navidrome (+ track count);
  lyrics resolve ≥ threshold (e.g. ≥80% of tracks); keys present; NAS reachable. Returns a
  structured pass/fail with reasons. Run it at the top of the flow.
- **Guardrail vs. judgment:** deterministic checks; Hermes decides skip / alert / retry-later on a
  soft fail (e.g. transient LRCLIB), hard-stops on a hard fail (album absent).
- **Acceptance:** preflight red-flags a missing album and a low-lyrics album with clear reasons.
- **Depends on:** none.

### T1-4 — Rescan poll-with-timeout before publish
- **Goal:** don't publish until Navidrome has actually indexed the staged segments.
- **Why now:** I manually checked `scanning: false` before each publish. `stage --rescan` triggers a
  scan but doesn't wait; publish assumes the episode album exists.
- **Build:** after `stage`, poll `navidrome scan-status` until `scanning:false` (or the episode
  album shows the expected song count), with a timeout + backoff. Only then publish.
- **Guardrail vs. judgment:** deterministic.
- **Acceptance:** publish is gated on a completed scan; times out with a clear error if the scan
  never settles.
- **Depends on:** none.

### T1-5 — Idempotent, safe end-to-end re-runs
- **Goal:** re-running any episode is safe and converges to the correct state.
- **Why now:** we hit two re-run edge cases — **orphan segments** from a restructured re-render (I
  cleaned them by hand; `stage --replace` only mirrors the NAS, so *local* orphans would propagate)
  and a cosmetic **stale `songCount: 18`** after a mirror. `publish` is already idempotent.
- **Build:** land the render output self-clean (T3-3, already in flight as a background task);
  document/verify the mirror + idempotent-publish invariants; optionally force a Navidrome refresh
  so `songCount` isn't stale. Add a smoke test that a double-run of an episode yields identical
  library state.
- **Guardrail vs. judgment:** deterministic.
- **Acceptance:** running the same episode twice back-to-back produces one clean album + one
  playlist, no orphans, correct counts.
- **Depends on:** T3-3.

---

## Tier 2 — Quality & judgment (Hermes does the heavy lifting)

This is where Hermes earns its keep — the work I did by hand each episode.

### T2-1 — Fact-check triage policy + sharper checker
- **Goal:** turn the noisy advisory fact-check into something Hermes can act on reliably.
- **Why now:** every episode I read the findings and separated **real embellishments** (the
  "Rumours" swap, "Nothing Studios closed") from **checker overreach** (flagging opinion, flagging
  its own reliable-sourced facts) and even a **hallucinated quote not in the script**. It's also
  **non-deterministic** — re-running surfaces a different subset — so naive "loop until clean" is
  whack-a-mole.
- **Build:** (a) harden `SCRIPT_FACTCHECK_SYSTEM` / add a verification step so a finding is only
  emitted if its `quote` appears **verbatim in the script** (kills hallucinated findings) and the
  claim genuinely isn't in the notes (cuts opinion/compression overreach). (b) Enrich the finding
  schema with a `category` (gear|credit|date|history|opinion) and `confidence`. (c) Define the
  **policy** Hermes follows: `CONTRADICTION` → block + retry `write` (bounded, e.g. ≤2) or
  hold-for-review; `UNSUPPORTED` → Hermes judges (ignore overreach/opinion/self-hedged; apply a
  targeted fix only when clearly a stated-as-fact invention). Cap total triage passes to avoid the
  loop.
- **Guardrail vs. judgment:** the checker + schema are deterministic; the disposition is Hermes's
  judgment, bounded by the retry cap and the "stop re-running" rule.
- **Acceptance:** on the two shipped scripts, the hardened checker drops the hallucinated-quote and
  opinion findings while still catching the "Rumours"/"closed" class.
- **Depends on:** `src/factcheck.ts`, `SCRIPT_FACTCHECK_SYSTEM`.

### T2-2 — Hermes decision contract (the PRODUCER playbook, productionized)
- **Goal:** encode what I did manually into Hermes's operating instructions.
- **Why now:** the step order, the retry/proceed/escalate calls, the guardrails, and the
  "when to stop" judgments currently live in my head + `PRODUCER_SYSTEM`. Hermes needs an explicit,
  testable playbook.
- **Build:** a Hermes system prompt / runbook: the full flow with preconditions; how to read a
  `preflight`/`budget`/`factcheck` result; the money/publish checkpoints (what needs human sign-off
  in each rollout phase); the fact-check policy (T2-1); the resume policy; and the escalation format.
  Keep it aligned with `PRODUCER_SYSTEM` (single source of truth for the flow).
- **Guardrail vs. judgment:** this *is* the judgment layer; guardrails are referenced, not
  re-implemented here.
- **Acceptance:** a fresh Hermes run, given only the playbook + the MCP tools, reproduces a
  supervised episode without hand-holding.
- **Depends on:** T0-1, T1-*, T2-1, T2-4.

### T2-3 — Deterministic quality floor (auto-QA beyond lint)
- **Goal:** catch writer regressions that `lint` (format-only) misses, cheaply and deterministically.
- **Why now:** I hand-verified lyric fidelity, length, ident presence, and reference-track spread
  each time. Several of these are cheap programmatic checks.
- **Build:** extend `lint` (or a new `qa` command) with: **lyric fidelity** — every quoted lyric
  line must appear verbatim in the research's Track Lyrics bank (the #1 hallucination guard);
  length within target minutes; station ident present in intro; N reference tracks present and
  reasonably spread; no spoken source tags (`[Wikipedia]`). Warnings vs. errors per severity.
- **Guardrail vs. judgment:** deterministic. Lyric-fidelity failures should be **hard** (block).
- **Acceptance:** a script with a misquoted lyric or missing ident fails QA.
- **Depends on:** none (pairs well with T2-1).

### T2-4 — Human-in-the-loop escape hatch (supervised autonomy)
- **Goal:** let Hermes pause and hand a decision to David instead of guessing on money/quality.
- **Why now:** this is the mechanism for the first rollout phase — Hermes does everything up to the
  render/publish gate, then holds and asks.
- **Build:** a `hold-for-review` run state + a notification payload (script summary, budget, QA +
  fact-check findings, a listen/preview link if available) delivered on the chosen channel; a
  resume path when David approves/edits. Approvals must be explicit and per-action (don't generalize
  one approval to the next episode).
- **Guardrail vs. judgment:** the *requirement* to hold on money/publish is a guardrail (per phase);
  the framing/summary is Hermes.
- **Acceptance:** Hermes reaches the gate, David gets a review ping, approves, Hermes finishes.
- **Depends on:** T0-2, T3-2 (notifications).

---

## Tier 3 — Operational polish

### T3-1 — Structured logging + per-run report
- **Goal:** make runs observable without a human tailing stderr.
- **Why now:** *I* was the observability layer — I spotted the quota error, the `songs=18`, the
  orphans. Unattended needs structured logs + a run summary (what was made, cost, findings,
  decisions, links).
- **Build:** structured logging across steps (reuse the run ledger, T0-2); emit a markdown/JSON
  run report at the end.
- **Acceptance:** a completed run leaves a self-contained report.

### T3-2 — Alerting / notifications
- **Goal:** pull a human in only when needed.
- **Build:** notify on failure, on `hold-for-review`, and on completion, over the chosen channel
  (ntfy / Slack / email / Hermes DM). Powers T2-4.
- **Open questions:** channel — Open questions for David #5.

### T3-3 — Render output self-clean *(in progress)*
- **Goal:** `render` reconciles its `audio/` dir against the current plan so restructured re-renders
  don't leave orphans that `stage` would push to the NAS.
- **Status:** a background task ("Reconcile render audio dir against plan; add CI workflow",
  branch `magical-curran`) is already on this. Fold it in and retire the manual orphan-check.
- **Acceptance:** a re-render after a structure change leaves no orphans; covered by a unit test.

### T3-4 — Scheduling & trigger
- **Goal:** "on a schedule or when asked."
- **Build:** the trigger that picks the **next `planned` episode** from `seasons.md` (host already
  specified per row) and kicks the flow — a cron entry or a Hermes schedule. On-demand path: a
  single natural-language trigger ("make the next episode" / a specific album).
- **Depends on:** the whole flow being unattended-safe (Tier 1 + Tier 2).

### T3-5 — Cost & usage tracking
- **Goal:** know what each episode cost and stay under the monthly ceiling.
- **Why now:** two episodes already spent ~18k of the 30k monthly key budget, and S01E02's partial
  render double-paid a few segments. Enforcing `monthly_cap` (T1-1) needs persisted spend.
- **Build:** record per-episode credit spend to the ledger; a small usage summary (tie into the
  existing `/billing` helper if useful).

---

## Rollout milestones

Don't jump to fully hands-off. Graduate:

- **Phase 0 — Supervised.** Hermes runs `preflight → research → verify → write → QA → factcheck →
  budget`, then **holds before render**, pinging David with the script, cost, and findings. David
  approves; Hermes finishes (render → stage → rescan → publish → status).
  *Needs:* T0-1, T0-2, T1-1, T1-3, T2-1, T2-2, T2-4.
- **Phase 1 — Bounded auto.** Hermes auto-proceeds through render/publish **within a hard budget
  cap and a clean preflight**, holding only on exceptions (an unresolved `CONTRADICTION`, a
  cap/credit breach, a preflight/QA hard-fail).
  *Needs:* all of Tier 1 + Tier 2, plus T3-1/T3-2.
- **Phase 2 — Scheduled auto.** A cron/Hermes schedule picks the next `planned` episode and runs
  the Phase-1 flow unattended, reporting results and holding only on exceptions.
  *Needs:* T3-3, T3-4, T3-5, T1-2 (resume).

---

## Work-package index

| ID | Tier | Package | Depends on | Rough size |
|----|------|---------|-----------|-----------|
| T0-1 | Foundation | Pipeline surface for Hermes (MCP) | — | M |
| T0-2 | Foundation | Run ledger & idempotency state | — | M |
| T0-3 | Foundation | Deployment & secrets topology | decision | S–M |
| T1-1 | Safety | Credit preflight + budget hard-stop | T0-2 | M |
| T1-2 | Safety | Render resume / partial recovery | T0-2 | M |
| T1-3 | Safety | Make-ability preconditions | — | S–M |
| T1-4 | Safety | Rescan poll-with-timeout | — | S |
| T1-5 | Safety | Idempotent end-to-end re-runs | T3-3 | S–M |
| T2-1 | Quality | Fact-check triage policy + sharper checker | — | M |
| T2-2 | Quality | Hermes decision contract (playbook) | T0-1, T1-*, T2-1, T2-4 | M |
| T2-3 | Quality | Deterministic quality floor (auto-QA) | — | S–M |
| T2-4 | Quality | Human-in-the-loop escape hatch | T0-2, T3-2 | M |
| T3-1 | Polish | Structured logging + run report | T0-2 | S–M |
| T3-2 | Polish | Alerting / notifications | — | S |
| T3-3 | Polish | Render output self-clean *(in progress)* | — | S |
| T3-4 | Polish | Scheduling & trigger | Tier 1+2 | S–M |
| T3-5 | Polish | Cost & usage tracking | T0-2 | S |

Suggested first sessions: **T1-3** (preflight — cheap, high value, no deps), **T1-1** (credit
guardrail — the quota wall), **T2-3** (auto-QA — cheap deterministic wins), then **T0-1/T0-2**
(the Hermes surface + ledger) to unlock the playbook.

---

## Open questions

**Resolved 2026-07-21** — see *Decisions & environment* above: interface (MCP), approval gate
(hold-before-render → full-auto), budget/volume (1/mo; word-count + credit preflight), publish
autonomy (folds into the approval-gate rollout), notifications (Telegram), fact-check strictness
(block `CONTRADICTION`, triage `UNSUPPORTED`), model policy (all-235b).

**Still open — the "digging":**

1. **NAS write path (T0-3 / T1-5).** Confirm the Phase-0 approach: keep `stage.ts` SSHing, but to
   the **Jellyfin LXC** (non-root, r/w mount) instead of `root@` the Proxmox host, to preserve the
   sandbox model? Or go straight to option **B** (r/w bind-mount into the pipeline LXC) and do the
   unprivileged-LXC uid-mapping work now? Need the Jellyfin LXC details (CTID, user, mount path) for
   option A.
2. **Pipeline LXC provisioning.** Confirm the shape: new LXC on `pve01`, Node/pnpm + clone
   `radio-documentaries`, `.env` provisioned via your existing pattern, MCP server as a user service
   (mirror the Hermes gateway's linger/systemd setup). Anything you want different?
3. **Hermes ↔ MCP wiring.** Verify `hermes-agent` can register a **remote** MCP server as a toolset
   in `~/.hermes/config.yaml` (network transport, not just local stdio), and how the allowlist/tool
   approval interacts with it. This is a Hermes-side spike, likely its own short session.
4. **Trigger UX.** Phase 0 = Telegram-only ("make the next episode" / "make S01E03")? Keep the
   `docuflow` CLI as the manual fallback? A real cron schedule is deferred to T3-4.
