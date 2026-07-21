# Script Format — SUB/WAVE Radio Documentaries

The contract every episode script follows. The **Script Writer Agent** produces a file in this exact shape; the **Producer Agent** validates it; the recording and playlist steps parse it mechanically. Read alongside `producer-guide.md` (the overall pipeline). If the two ever disagree, the producer-guide's flow wins and this file should be corrected.

The whole point of this format: a finished script can be **split into segments and sent to ElevenLabs one at a time, with no editing of the resulting audio**. Everything below serves that.

---

## 0. Where the script lives

The Producer Agent creates a working directory per episode (flow step 2):

```
S01E01-<album-slug>/
  research.html          # Researcher Agent's notes (the ONLY source the writer may use)
  script.md              # <- this format
  qc-issues.md           # Writer's uncertainty log (see §6)
  audio/                 # created at recording time
    s01e01_01_intro.mp3
    s01e01_02_part-1.mp3
    ...
```

`<album-slug>` = lowercase, hyphenated album title.

---

## 1. Front matter (required)

The file opens with a YAML block. The pipeline reads it for naming, voice selection, model, and budgeting.

```yaml
---
season: 1
episode: 1
album: "Punisher"
artist: "Phoebe Bridgers"
host: p_jools            # persona id from subwave-config (p_jools or p_cara)
host_name: "Jools"       # display name, must match the persona
model: eleven_flash_v2_5 # default; may be eleven_multilingual_v2 after the A/B sample gate
target_minutes: 25       # aim 20–30 total (spoken + songs)
reference_tracks: 2      # count of SONG slots below (1–3)
---
```

Rules:
- `host` must be one of the documentary hosts (`p_jools`, `p_cara`) — see `producer-guide.md` → SUB/WAVE Personas.
- `model` stays `eleven_flash_v2_5` unless a per-season A/B comparison has been run and David chose otherwise.

---

## 2. The slot model (the core idea)

A script is an **ordered list of slots**. Every slot has a **two-digit playback index** that is monotonic across the *whole* episode — spoken and song slots share one sequence. That index is the playback order **and** the filename number.

Two slot types:

| Type | Produces audio? | Becomes |
| --- | --- | --- |
| `SPOKEN` | Yes — its text is sent to ElevenLabs | `sXXeXX_NN_<label>.mp3` |
| `SONG` | No — it's a reference to a track already in Navidrome | a playlist entry (Subsonic ID), no file |

Because the index is shared, song slots consume a number too, so the mp3 filenames have gaps — that is intended and correct. Example rundown:

| Index | Type | Label | File |
| --- | --- | --- | --- |
| 01 | SPOKEN | intro | `s01e01_01_intro.mp3` |
| 02 | SPOKEN | part-1 | `s01e01_02_part-1.mp3` |
| 03 | SONG | song-1 | *(no file — Navidrome track)* |
| 04 | SPOKEN | part-2 | `s01e01_04_part-2.mp3` |
| 05 | SONG | song-2 | *(no file)* |
| 06 | SPOKEN | conclusion | `s01e01_06_conclusion.mp3` |

The playlist (built later, on prompt) is just these six slots in index order. This table is the **cue sheet** — the pipeline derives it directly from the slot headings; the writer does not maintain it by hand.

**Filename convention:** `s{season:02}e{episode:02}_{index:02}_{label}.mp3`, label kebab-case. Season/episode two-digit zero-padded.

---

## 3. Slot syntax (machine-parseable)

Each slot begins with a heading in this exact form, then its body until the next heading:

```
## [NN] SPOKEN · <label>
```
or
```
## [NN] SONG · <label>
```

Parser contract: a slot heading matches `^## \[(\d{2})\] (SPOKEN|SONG) · (.+)$`. Everything from that line to the next `## [` heading (or EOF) is the slot body. **Do not** use `## [` for anything but slot headings.

### SPOKEN body

The body is **the exact words to be spoken — nothing else.** No markdown, no headings, no bullet lists, no stage directions, no labels, no "[Jools]:" prefixes. Just clean prose. Whatever is in the body is what ElevenLabs speaks, verbatim.

```
## [02] SPOKEN · part-1
Phoebe wrote most of this record on the road, in hotel rooms, in the gaps between
someone else's tour. And you can hear it — that low, insomniac hum under everything...
```

### SONG body

A short metadata list — enough to resolve one track in the album (album and artist come from front matter, but repeat them for safety):

```
## [03] SONG · song-1
- title: "Kyoto"
- artist: "Phoebe Bridgers"
- album: "Punisher"
- note: play in full; Jools hands off to it at the end of part-1 and picks up in part-2
```

`note` is a producer-facing hint, **never spoken**. Songs play **in full, clean** — no talking over intros/outros. The writer builds the hand-off and pick-up into the surrounding SPOKEN slots.

---

## 4. Writing for the ear (TTS-safe prose)

The default model is **ElevenLabs Flash v2.5, which does _not_ support audio tags** (`[laughs]`, `[sighs]`, etc.). Do not use them. Control delivery with punctuation and sentence shape only.

- **Pacing:** commas and ellipses (`...`) for pauses; periods for full stops; short sentences for emphasis. Paragraph breaks are natural breaths.
- **No visual-only content:** no URLs, no "as you can see," no markdown, no numbered lists read aloud awkwardly.
- **Numbers, years, dates:** write them the way they should be *said* if there's any ambiguity ("nineteen ninety-four," "nineteen dollars"). Trust the model for simple cases; spell out anything risky.
- **Acronyms / initialisms:** write to the desired reading — `EMI` if it should sound like a word, `E M I` (spaced) if it should be spelled out. When unsure, log it in `qc-issues.md`.
- **Tricky names (artists, producers, places, gear):** if a name is likely to be mispronounced, use a light inline phonetic respelling **and** log it in `qc-issues.md` so David can verify. Don't over-respell — only genuine risks.
- **One voice throughout.** The narration is the host talking to one listener, in that persona's `soul`/tone. No interviews, no second voice (there's only one TTS voice per episode).

### Segment sizing

- Aim **~300–700 words per SPOKEN slot** (~2–5 minutes). Vary length for rhythm.
- If a single idea needs more, split it into consecutive SPOKEN slots rather than one giant block — keeps each ElevenLabs request comfortably within limits and gives the pipeline clean seams.
- Rough duration math for hitting `target_minutes`: **~150 spoken words ≈ 1 minute.** Each SONG adds its own runtime (typically 3–5 min). So a 25-min episode with two songs ≈ **~2,500–3,000 spoken words** across the SPOKEN slots.

### Continuity across seams

Consecutive **SPOKEN** slots (no song between them) are stitched at recording time using ElevenLabs request-stitching (`previous_text` / `next_text`) so the prosody doesn't jump. A **SONG** between two spoken slots is a hard reset — no stitching needed across it. Write hand-offs accordingly: the slot before a song should land cleanly, and the slot after it should re-open.

---

## 5. Fidelity rules (hard constraints)

- **The writer uses ONLY `research.html`.** No web searching, no drawing on model background knowledge, no guessing, no invented anecdotes, quotes, dates, or personnel. If it isn't in the research notes, it doesn't go in the script.
- If the research is thin or contradictory, **write around it and log the gap** (§6) — do not fill it with plausible-sounding fabrication. This is doubly important for **Jools**, whose whole character is that he never invents facts.
- Reference tracks must be from the episode's album (they'll be resolved against that album in Navidrome).

---

## 6. `qc-issues.md` (required companion file)

The writer's honesty log, so the Producer can fix research gaps before recording. One bullet per issue:

```markdown
# QC Issues — S01E01 Punisher

- [blocker] Slot 04: research doesn't say whether "Punisher" is Phoebe's 2nd or 3rd
  solo record. Wrote around it; confirm before recording.
- [nice-to-have] Slot 02: no context on what other artists were doing in this scene
  in 2020 — a contemporaries line would strengthen the intro if research can add it.
- [pronunciation] Slot 05: producer "Tony Berg" — confirm it's BERG (hard g), not "Bairg".
```

Severity tags: `[blocker]` (must resolve before recording), `[nice-to-have]` (would improve it), `[pronunciation]` (verify a name). Empty file with just the heading is fine if there were genuinely no issues.

---

## 7. Minimal complete example

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
Some records you admire. A few you climb inside and live in for a while. Punisher,
to me, is the second kind... Tonight, where it came from, and why it hits the way it does.

## [02] SPOKEN · part-1
She wrote most of it between other people's tours...

## [03] SONG · song-1
- title: "Kyoto"
- artist: "Phoebe Bridgers"
- album: "Punisher"
- note: play in full; hand off at end of part-1, pick up in part-2

## [04] SPOKEN · part-2
That brass you just heard? Recorded almost as an afterthought...

## [05] SONG · song-2
- title: "I Know the End"
- artist: "Phoebe Bridgers"
- album: "Punisher"
- note: play in full; the closer

## [06] SPOKEN · conclusion
So that's Punisher. A record made in the cracks of everything else...
```
