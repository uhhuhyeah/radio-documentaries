# SUB/WAVE Documentaries — Catalog

The authoritative index of every documentary season and episode. The **Producer Agent** reads this to assign the next episode number, and appends/updates a row as an episode moves through the pipeline. Working-directory names and episode numbers **derive from here** — if this file and a working dir ever disagree, **this file wins**.

**Active season: 1** ← new episodes land here unless the trigger names another season.

**Status lifecycle:**

| Status | Meaning |
| --- | --- |
| `planned` | Queued for a season, not started (used for season planning). No dir yet. |
| `in-production` | Working dir created; research/script/audio underway. |
| `recorded` | Audio delivered to the working dir; awaiting David's manual move to the NAS + rescan. |
| `published` | Navidrome playlist built and live. |

---

## How the Producer Agent uses this file

On a new trigger (e.g. *"Making of Punisher by Phoebe Bridgers, Jools to host"*):

1. **Pick the season** — the season named in the trigger, else the **Active season** above.
2. **Claim or append:**
   - If a `planned` row in that season matches the album/artist → **claim it**: set Status `in-production`, fill Dir. (If the trigger's host differs from the planned host, the **trigger wins** — update the Host cell.)
   - Otherwise → **new episode**: Ep = (highest Ep in that season) + 1. Append a row, Status `in-production`.
3. **Name the working dir** `S{season:02}E{ep:02}-<album-slug>` to match the Dir cell (e.g. `S01E01-punisher`).
4. **Advance Status** as the episode progresses: `in-production` → `recorded` (audio delivered) → `published` (playlist built). Fill the **Published** date (YYYY-MM-DD) when the playlist goes live.
5. **Never renumber.** Once assigned, an episode number is permanent.

**To plan a season:** pre-add `planned` rows (Ep numbers, albums, artists, intended hosts) before any production. Leave Dir/Published as `—`. Production later claims each planned row in step 2.

Format reference (illustrative — not live episodes):

```
## Season 1 — <optional theme>

| Ep | Album    | Artist          | Host  | Status       | Dir              | Published  |
| -- | -------- | --------------- | ----- | ------------ | ---------------- | ---------- |
| 01 | Punisher | Phoebe Bridgers | Jools | published    | S01E01-punisher  | 2026-07-20 |
| 02 | Sound Ancestors | Madlib   | Jools | planned      | —                | —          |
```

---

## Season 1

| Ep | Album | Artist | Host | Status | Dir | Published |
| -- | ----- | ------ | ---- | ------ | --- | --------- |
| 01 | Punisher | Phoebe Bridgers | Cara | recorded | S01E01-punisher | — |


