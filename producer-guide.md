# Intro - what's the point

In this repo we will research, edit, and produce LLM-powered "radio documentaries" for me based off the DJ personas in `~/code/homelab/subwave-config` for my homelab-based LLM-powered radio SUB/WAVE.

## SUB/WAVE

**Canon:** vault note `SUBWAVE AI Radio` (what it is / how to reach it) + `SUBWAVE AI Radio - Dev Log` (dev history). Config-as-code lives in `~/code/homelab/subwave-config`. Keep this section a summary; the vault is the source of truth.

SUB/WAVE is David's personal AI-DJ internet radio station, self-hosted on the Brookgrass homelab (Proxmox host `pve01`, LXC **107**, Docker Compose). One Icecast stream, one broadcast — every listener hears the same thing at once. An LLM "DJ brain" picks tracks from the music library, sequences them by mood, and talks between songs (weather, anniversaries, deep cuts) via text-to-speech in a chosen **persona** voice.

How the pieces fit — the same building blocks this repo reuses for documentaries:

| Piece | What it does | Detail |
| --- | --- | --- |
| **Navidrome** | Music library + streaming backend | Self-hosted music server, LXC **106**, `http://192.168.1.110:4533`, Subsonic API. ~845 tracks / 43 artists, mood-tagged. This is where documentary reference tracks come from and where finished episodes are published as playlists. See `## Navidrome` below. |
| **OpenRouter** | The LLM "DJ brain" | Drives track-picking and between-song patter. Current model `qwen/qwen3-235b-a22b-2507` (chosen for reliable structured-output emission). *Not directly used by the documentary pipeline — our research/writing agents run on their own models — but it's the same station intelligence.* |
| **ElevenLabs** | Per-persona cloud TTS (the voices) | Every persona speaks through an ElevenLabs voice. Restricted key **"SUBWAVE"** on David's account, model **Flash v2.5** (`eleven_flash_v2_5`), ≈0.5 credits/char (a typical DJ line ≈100–150 credits). **This is the exact mechanism the documentary pipeline uses to voice each script segment.** See `## ElevenLabs` below. |
| **OpenAI** | Fallback TTS + embeddings | Global cloud-TTS fallback (`gpt-4o-mini-tts`/nova) and mood-tagging embeddings (`text-embedding-3-small`). Not used by the documentary pipeline. |

Persona identity, voice, and behaviour are runtime config in the station's `settings.json`, synced live (no restart) through the admin API via `subwave-config` (`pull.sh` / `push.sh`). **The persona bios and voice IDs below are lifted from that live config** — treat `subwave-config/config/settings.json` as the authority if they ever drift.


## SUB/WAVE Personas

The station runs four personas (Cara, Rupert, Jools, Sophie). **The "Making Of" documentaries are hosted by two of them: Cara and Jools.** Each persona's on-air identity is a compact `soul` prompt (≤400 chars) plus tone dials; the Script Writer Agent must write in the assigned host's voice, and the audio is rendered through that host's ElevenLabs voice ID at the specified speed.

Voice-ID note: the values below are the live ElevenLabs voice IDs from `subwave-config`. All persona TTS uses `engine: cloud`, `cloudProvider: elevenlabs`, model **Flash v2.5**. Verify against `subwave-config/config/settings.json` before a production run — voices have been swapped before.

### Cara — the pop host

- **ElevenLabs voice ID:** `ZF6FPAbjXT4488VcRRnw` (ElevenLabs voice "Amelia") · **speed 1.1** · engine `cloud`/`elevenlabs`
- **Tagline:** *"Non-stop pop, darling. The party never ends, it just changes postcode."*
- **Tone dials** (0–10): humour **8**, localColour **5**, warmth **6** — ironic wit.
- **Soul:** bubbly British it-girl hosting a non-stop pop party; flirty, gossipy, a little chaotic; openly ironic about fame, paparazzi, afterparties and her own hangovers while genuinely adoring every track she plays; name-drops celebrity friends who may or may not exist; treats the listener like her best mate in the back of the limo at 3am; pokes fun at influencer culture, award shows and her own publicist.
- **Origin/flavour:** a homage to GTA V's *Non-Stop-Pop FM*. She's the station's default/active on-air persona.
- **Best fit for documentaries on:** pop, dance, chart-facing and celebrity-adjacent records — anywhere gossip, glamour and self-aware irony sharpen the story. Keep her affection for the music genuine underneath the wit.

### Jools — the music sherpa

- **ElevenLabs voice ID:** `1BUhH8aaMvGMUdGAmWVM` (ElevenLabs voice "Alyx") · **speed 1.0** · engine `cloud`/`elevenlabs`
- **Tagline:** *"A guide through the good stuff: deep cuts, overlooked gems, and why they matter."*
- **Tone dials** (0–10): humour **5**, localColour **5**, warmth **8** — earnest warmth.
- **Soul:** British music obsessive in the lineage of John Peel, Jo Whiley and Zane Lowe; a sherpa who guides you through the library, not just plays it. Lives for deep cuts and tells you why each matters — digging up a concrete liner note (producer, label, scene, a chart or session story) and letting you in on it. Stays grounded; never invents facts or trivia about an artist.
- **Best fit for documentaries on:** the marquee "Making Of" format — album deep-dives where craft, context and liner-note detail carry the show. His grounded, never-invent-facts ethos is a natural match for this repo's hard rule that the Script Writer works only from the Researcher's notes.
- **Important:** Jools's defining trait is that he *does not make things up*. The pipeline's separation (writer uses only researched facts) exists to protect exactly this — respect it when scripting him.

*(Rupert — velvety Classic FM presenter — and Sophie — warm Glaswegian storyteller — round out the station roster but are not documentary hosts for now. Full bios in the vault note `SUBWAVE AI Radio` → Personas.)*

## "Making of" documentaries

The first programme we will produce will be a series of "making of" documentaries based off of albums in my Navidrome collection that I am fond of. There will be other programming later. 

**High-level flow**

1. I will provide, in the trigger prompt, a target **album**, **artist** (that exists in Navidrome), and the **host** to present it — e.g. *"Making of Punisher by Phoebe Bridgers, Jools to host."* There is no default host; the host is always named in the prompt (Cara or Jools). I may optionally name a **season** (e.g. "…for season 2"); if I don't, the Active season applies. **I never give the episode number** — the Producer Agent derives it.
2. Producer Agent will:
  - **Assign the season/episode number from `seasons.md`** (the catalog): use the trigger's season or the Active season, then claim a matching `planned` row or append the next number (highest Ep + 1). It updates the catalog row to `in-production`. Numbering rules live in `seasons.md`.
  - **Validate the basics** — confirm the album/artist resolves in Navidrome and the named host is a valid documentary persona (Cara/Jools) — and resolve any discrepancy up front.
  - **Create the working directory** `S{season:02}E{ep:02}-<album-slug>` (matching the catalog Dir cell) for the new work.
3. Producer Agent will task Researcher Agent to scour the internet for details and anecdotes surrounding the making of that specific album and prepare detailed and organised notes to pass back to Producer Agent.
  - Example prompt I have used in the past:
  ```
  Do a deep dive for me on the making of Pheobe Bridgers' "Punisher" album. I want to know as much as possible about the writing process, the instruments used, the studios used, the recording chain(s), the challenges and triumphs that went into making this record. When you have gathered all of this, I want you to make for me a file for me to read and reference. But instead of a markdown file, please use HTML and take advantage of the extra latitude you get with layout, style and interactivity. (Context: I am a musician and write and record my own material and this is one of my top albums from a writing and production standpoint. I want to absorb and learn. Approach this like I am an avid fan and fellow songwriter/musician/producer.)
  ```
4. When Producer Agent is happy with the research, it will dispatch the Script Writer Agent to read the research notes and compile a script for the show's episode (using the research given - the writer agent will not do any of it's own web searching and it will not guess or make up details, so it's imperitive that the Researcher Agent provide exhaustive notes).
  - The Script Writer agent will target content to be 20-30 minutes in length where possible
  - The Script Writer agent will write a script that reflects the persona of the host who will be presenting the content.
  - The Script Writer agent will include actual songs from that album, **interleaved throughout like a radio show** — **3-5 reference tracks** from the album, spread across the episode (spoken → song → spoken → song …), not clustered.
  - The Script Writer agent will provide a formatted script file in the working directory set up by the Producer Agent in step 2 that can be easily split into spoken segments and passed section by section into the ElevenLabs API without the need for editing of the outcoming audio. **The script format is specified in `script-format.md` (slot model, filenames, TTS-safe prose rules) — the Writer Agent follows it exactly.**
  - To aid in quality control, the Script Writer Agent will also output a list of issues it had (if any) with the research into a file in the working directory. Eg if the Script Writer Agent didn't know if this album was the band's 2nd album or 3rd album, or if the research didn't include any context for what other bands were doing things in the same time/space and wanted to reference.
5. With the delivered script, the Producer Agent will ensure quality and formatting, directing back the Script Writer agent any necessary tweaks or fixes. 
6. With a finalised script, the Producer Agent will supervise a subagent to convert segments of the script into sorted/organised audio files via the ElevenLabs API using the desired DJ Persona Voice.
  - For example, there is an intro, part 1, song 1, part 2, conclusion in a script, we would send the intro text to ElevenLabs for `sXXeXX_1_intro.mp3`, part 1 into `sXXeXX_2_part_1.mp3` etc. Song 1 is not an ElevenLabs concern because that would be referencing a song from this album that is in Navidrome.
7. With all script parts recorded, publishing to Navidrome is **split into two workflows** (Navidrome's music mount is read-only to the agent — see `## Navidrome`):
  - **7a. Agent hand-off → stage to NAS.** The Producer Agent delivers the finished, **ID3-tagged** segment MP3s in the working directory, named in playback order, alongside a **rundown/cue sheet** (the ordered list of every slot — spoken segments and reference songs), and sets the episode's `seasons.md` status to **`recorded`**. The MP3s then get copied onto the NAS Music share via **`stage_audio` / `pnpm cli stage-audio <workdir> [--replace] [--rescan]`** — an rsync over SSH to the read-write **PVE host** (Navidrome's own mount is read-only). Configurable in `settings.toml` `[nas]`. *(This can be run by David or the agent; historically it was a manual `scp`. Use `--replace` when re-publishing to remove stale files.)*
  - **7b. Prompted playlist build.** *After* the rescan, when David prompts it, the agent resolves the Subsonic IDs (new segments + in-place reference tracks) and creates the Navidrome playlist for the Season/Episode with every part in the correct order and reference songs slotted in. It then sets the `seasons.md` status to **`published`** and fills the Published date. On-demand, not automatic.
  - The end result: David loads that playlist in Navidrome, plays it in order, and hears a well-researched, well-written, well-hosted radio documentary on a given album.


## ElevenLabs

This is how each script segment becomes an audio file (step 6 of the flow). Docs / cookbook: <https://elevenlabs.io/docs/eleven-api/guides/cookbooks/text-to-speech>. Confirm exact request-body field names against the live docs at build time — the shape below is the stable surface, but treat the docs as authority.

**Credentials — decided: a dedicated docs key.** Issue a *separate* restricted ElevenLabs key for this repo (Text-to-Speech access, its own per-key credit cap) — **do not** reuse the live station's "SUBWAVE" key. This isolates documentary budget so a batch render can't exhaust the on-air station's credits mid-broadcast (the 2026-07-01 outage was a spent per-key cap dropping every persona to Piper). Same account/plan, just a separate key. Do **not** commit it; keep it in a gitignored `.env` here. Account = David's ElevenLabs Starter plan (**30k credits/mo**, shared pool across all keys — so a doc render still draws down the same monthly plan the station uses; the separate cap protects against *runaway* spend, not from sharing the monthly total). *Setup TODO: create the key on David's ElevenLabs account and drop it in `.env`.*

**The call** (one HTTP POST per segment):

```
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
Headers: xi-api-key: <ELEVENLABS_API_KEY>,  Content-Type: application/json
Body: {
  "text": "<segment text>",
  "model_id": "eleven_flash_v2_5",
  "voice_settings": { "stability": 0.5, "similarity_boost": 0.75, "style": 0, "use_speaker_boost": true, "speed": <persona speed> }
}
```

Response body is raw MP3 bytes → write straight to `sXXeXX_N_label.mp3`. (An official `elevenlabs` Python/Node SDK exists and wraps this; either the SDK or a plain `requests`/`fetch` call is fine — a plain HTTP call keeps the dependency surface minimal.)

**Per-persona voice + speed** (from `subwave-config`, must match the host of the episode):

| Host | `voice_id` | `voice_settings.speed` |
| --- | --- | --- |
| Cara | `ZF6FPAbjXT4488VcRRnw` | 1.1 |
| Jools | `1BUhH8aaMvGMUdGAmWVM` | 1.0 |

**Model choice — decided: A/B sample gate before full production.** Candidates: **Flash v2.5** (`eleven_flash_v2_5`), ≈**0.5 credits/char**, the station standard — fast and good; vs. **Multilingual v2** (`eleven_multilingual_v2`), ≈**1 credit/char**, potentially more expressive for long-form narration at ~double the cost. **Before any season goes into full production, the pipeline renders 1–2 sample segments through *both* models** (same voice/text) for David to compare, then he decides whether the quality gain justifies the extra cost. Default to Flash v2.5 unless that comparison says otherwise; record the chosen model per season.

**Budget — read before a production run.** A 20–30 min episode is a lot of speech: ~3,000–4,000 spoken words ≈ **18,000–24,000 characters**. At Flash v2.5 that's **≈9,000–12,000 credits per episode** — *over a third of the 30k/mo plan, and it competes with the live station's ongoing TTS usage.* Implications the pipeline must respect:
- Budget-check before rendering; estimate credits from the script's char count and surface it to the Producer for go/no-go.
- Strongly favour Flash v2.5 (Multilingual v2 would be ~double, ≈one whole episode = ~⅔ of the monthly plan).
- A **dedicated docs key** is used (decided above) so a runaway batch render can't blow the station's per-key cap — but note both keys still draw from the **same 30k/mo plan pool**, so heavy doc rendering and heavy on-air use compete for the monthly total. Budgeting per episode remains essential; this is the single biggest operational risk in the pipeline.

**Segmentation & continuity.** Split the script into ordered segments (intro / part_N / conclusion) — one request each, **skipping song slots** (those are Navidrome tracks, not TTS). To avoid audible prosody jumps at segment seams, use the cookbook's **request-stitching** (pass the neighbouring segments' text as `previous_text` / `next_text`, and/or chain `previous_request_ids` / `next_request_ids`). Keep each segment comfortably under the model's per-request character limit; if a single segment is very long, sub-chunk it and stitch. Output **`mp3_44100_128`** so it matches the library; then embed ID3 tags (see Navidrome) before publishing.


## Navidrome

**Canon:** vault note `Navidrome Music Server`. This section covers only what the pipeline needs to *publish* an episode (step 7). Navidrome is the self-hosted, Subsonic-compatible music server on LXC **106**, `http://192.168.1.110:4533`, reachable over Tailscale. It reads its library from the Synology NAS Music share.

**The read-only gotcha (most important fact).** Navidrome's music mount is **read-only** (`mp0: /mnt/nas/music,mp=/mnt/music,ro=1`), so the agent does not write episode audio into the library at all. **Decided workflow: David moves the files manually.** The same NAS share (`192.168.1.93:/volume1/Music`) is writable from the PVE host (`/mnt/nas/music`, NFS `rw`) and Jellyfin LXC 101 (`/mnt/music`, rw) if a scripted copy is ever wanted, but by default the agent's job ends at delivering tagged files + a cue sheet; David does the move.

**Two distinct workflows (do not conflate them):**
- **Stage (David or agent).** `stage_audio` / `pnpm cli stage-audio <workdir> --rescan` copies the ID3-tagged MP3s into `<nas music dir>/<episode-dir>/` on the NAS (rsync over SSH to the read-write PVE host) and triggers a Navidrome rescan. `--replace` mirrors (removes stale files) when re-publishing.
- **Playlist build (agent, on-demand).** *Only after the rescan*, when prompted, the agent resolves Subsonic IDs and creates the playlist. It never assumes the files are already scanned — it verifies (a `search3`/`getAlbum` lookup returns the segments) before building, and says so if they're not visible yet.

**Tags are mandatory.** Navidrome is strictly tag-based — files without embedded ID3 metadata land under `[Unknown Artist]`/`[Unknown Album]` regardless of folder names. Before copying, each segment MP3 **must** carry ID3 tags. Proposed scheme (decide + record):
- `ARTIST` = `SUB/WAVE Documentaries` (**decided** — keeps every episode grouped under one artist, cleanly separated from the real-music catalog).
- `ALBUM` = the episode, e.g. `S01E01 — <Album> (Making Of)`.
- `TITLE` = segment label (`Intro`, `Part 1`, …).
- `TRACKNUMBER` = playback order (segments only; reference songs keep their own tags).

**Folder layout on the NAS** (example): `/mnt/nas/music/SUB-WAVE Documentaries/S01E01 - <Album> Making Of/` holding only the spoken-segment MP3s. The **reference album tracks stay where they already live** in the library — they're pulled into the playlist by their existing Subsonic ID, not copied.

**Publish sequence:**
1. *(Agent, at production time)* Embed ID3 tags into the segment MP3s (e.g. `ffmpeg` / `mutagen` / `id3v2`) in the working directory and deliver them + the cue sheet. **The agent stops here.**
2. *(Manual, David)* Move the tagged MP3s into an episode folder on the NAS Music dir, then **trigger a rescan** — `GET /rest/startScan.view` (Subsonic API) or the web UI; otherwise the hourly `ScanSchedule = "1h"` picks them up eventually.
3. *(Agent, when prompted)* **Resolve Subsonic IDs**: the new segment tracks (via `getAlbum` on the new episode "album", or `search3`) and the reference album tracks (via `getAlbum` / `search3` on the source album named in the script). If the segments aren't visible yet, stop and tell David the scan hasn't completed.
4. *(Agent, when prompted)* **Build the playlist** in exact listen order from the cue sheet — spoken segments interleaved with reference songs at their scripted slots (intro → part 1 → *song A* → part 2 → *song B* → conclusion). Use Subsonic **`createPlaylist`** with the ordered `songId` list (Navidrome preserves submitted order); adjust later with `updatePlaylist` (`songIdToAdd` / `songIndexToRemove`). Name it for the season/episode, e.g. `SUB/WAVE Docs — S01E01 <Album>`.

**Subsonic API essentials:** base `http://192.168.1.110:4533/rest/<method>.view`, params `u=david`, token auth `t=md5(password+salt)` & `s=<salt>` (or `p=` plaintext), plus `c=<client>&v=1.16.1&f=json`. Credentials = the Navidrome `david` account (in vault; also `NAVIDROME_*` in `/opt/subwave/.env`). ⚠️ That password is shared by SUB/WAVE and Homepage — **read-only use here; never rotate it from this repo** (rotation fans out to 3 services — see the vault note).

*(Alternative playlist mechanism: Navidrome can import `.m3u` files, but the Subsonic API path above is cleaner and config-independent — prefer it.)*


## Automation & what's scriptable

**Design intent:** this pipeline is a **deterministic harness with two LLM stages**, not one big prompt an LLM is trusted to follow. Everything that *can* be code should be code; the LLM is confined to research and writing, both behind machine-checkable gates. The format contract (`script-format.md`), the catalog (`seasons.md`), and the API-based publish path are what make that possible. This is a target architecture — not built yet — recorded so implementation is legible when we get to it.

**Stage breakdown** — what's deterministic code vs. what genuinely needs an LLM:

| Flow step | Nature | Mechanism |
| --- | --- | --- |
| 1. Trigger (album/artist/host/season) | **Script** | Structured input. In an automated run it's not a prompt at all — it's the next `planned` row in `seasons.md`. |
| 2a. Episode numbering | **Script** | Read `seasons.md`, increment, append. |
| 2b. Validate album/host resolves | **Script** | Subsonic `search3` against Navidrome; host ∈ {Cara, Jools}. Fuzzy-match + flag ambiguity. |
| 2c. Create working dir + front matter | **Script** | Templated scaffold. |
| **3. Research** | **LLM** | Irreducible. Deep web research → `research.html`. |
| **4. Script writing** | **LLM** | Irreducible. Persona voice, research-only → `script.md`. |
| 4b. Format/QC lint | **Script** | Validate `script.md` against `script-format.md`: front matter valid, slot headings parse, indices monotonic, song metadata present, word-count→duration in band. **Gates the LLM output mechanically.** |
| 5. Editorial QC | **Hybrid** | Format = lint (script); "is it good" = LLM/human. |
| **6. TTS render** | **Script** | Parse slots → ElevenLabs POST per SPOKEN slot (voice/model/speed from config) → request-stitch → save → embed ID3 tags. |
| 6b. Budget check / A-B sample | **Script** | Char-count × credit rate vs. a cap; render 1–2 segments both models. |
| 7a. Deliver tagged files + cue sheet | **Script** | Derived from the parsed script. |
| **7a→7b. Move to NAS** | **Human** | The one true automation seam (deliberate — see Navidrome § read-only gotcha). |
| 7b. Rescan-check + resolve IDs + build playlist | **Script** | Subsonic `startScan` / `getAlbum` / `createPlaylist`. |

**Only steps 3 and 4 require an LLM**, and even they are bounded — research has a defined deliverable, and the script must pass the linter before rendering.

**Harness shape (when built):** a thin driver + small deterministic modules, two of which shell out to an LLM. State lives in `seasons.md` + the working dir (no database; matches house style). Resumable — each stage checks what's already done.

- `catalog` — read/append `seasons.md`, compute next episode
- `navidrome` — Subsonic client (resolve IDs, scan, create playlist)
- `render` — `script.md` → tagged MP3s via ElevenLabs
- `lint_script` — enforce the format contract
- `budget` — estimate/cap credits
- `research` + `write` — the two LLM calls (Claude API/SDK, or the Hermes homelab runtime once it drives things)
- `run` — orchestrator: resumable, **pauses at the NAS-move seam**, resumes on the next trigger

**Toward monthly automation (the eventual goal):** a cron produces research→script→render→stage, then pings David "*SxxEyy ready to move*"; after he moves the files and Navidrome rescans, a second invocation builds the playlist. Human-in-the-loop by design, and the manual NAS move fits that cadence cleanly. Four things a fully unattended run must handle:

1. **The manual NAS move** — makes the run naturally **two-phase** (produce-and-stage, then publish). Fine for now; the harness pauses and resumes. (It *could* write via the PVE-host RW path if we ever want hands-off, but manual is the chosen default.)
2. **Album source** — the cron pops the next `planned` row from `seasons.md`. **This is why season planning matters: the plan is the automation queue.**
3. **ElevenLabs budget** — ~10k credits/episode against a shared 30k/mo plan → budget-check with a confirm or hard cap before spending.
4. **QC blockers** — if the Writer logs a `[blocker]` in `qc-issues.md`, the run **halts and notifies** rather than proceeding on guesses.

**Hermes-driven path:** when the orchestrator is Hermes over MCP (not the local `run` driver), its operating manual is [`hermes-playbook.md`](hermes-playbook.md) — the phase model, gate-reading rules, retry/hold/escalate policy, and the Telegram handoff format. `PRODUCER_SYSTEM` stays the source of truth for the flow order.
