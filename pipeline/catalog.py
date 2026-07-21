"""Read and safely mutate the episode catalog (``seasons.md``).

The catalog is the authoritative source for episode numbers and status. These
helpers operate on the raw markdown lines so the surrounding prose, legend, and
"How the Producer Agent uses this file" section are never disturbed — only the
per-season table rows change.

Numbering rule (from seasons.md): episode = highest Ep in the season + 1, per
season (numbers reset each season). Season planning = pre-added ``planned`` rows,
which ``assign`` claims instead of appending a duplicate.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "seasons.md"

SEASON_HEADING = re.compile(r"^##\s+Season\s+(\d+)", re.I)
ACTIVE_SEASON = re.compile(r"Active season:\s*\*{0,2}(\d+)", re.I)
COLUMNS = ["Ep", "Album", "Artist", "Host", "Status", "Dir", "Published"]
PLACEHOLDER_MARK = "no episodes yet"
EMPTY = "—"


class CatalogError(Exception):
    pass


@dataclass
class Row:
    season: int
    ep: int | None       # None for the placeholder row
    album: str
    artist: str
    host: str
    status: str
    dir: str
    published: str
    lineno: int          # 0-based index into the file's line list


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "untitled"


def _cells(line: str) -> list[str]:
    parts = [c.strip() for c in line.strip().split("|")]
    # split of "| a | b |" yields ['', 'a', 'b', ''] -> drop the outer empties
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return parts


def _is_table_line(line: str) -> bool:
    return line.strip().startswith("|")


def _is_separator(line: str) -> bool:
    return _is_table_line(line) and set(line.strip()) <= set("|-: ")


def _is_header(line: str) -> bool:
    return _cells(line)[:1] == ["Ep"]


def _is_placeholder(line: str) -> bool:
    return PLACEHOLDER_MARK in line.lower()


def _mask_fences(lines: list[str]) -> list[str]:
    """Blank out lines inside ``` / ~~~ code fences, preserving line indices.

    seasons.md carries an *illustrative* example table inside a fence (heading and
    all). Masking it keeps the parser from mistaking the example for real data,
    while index-preservation means mutations still target the right real lines.
    """
    out, in_fence = [], False
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            out.append("")
            continue
        out.append("" if in_fence else line)
    return out


# --- reading -----------------------------------------------------------------

def read(path: str | Path = DEFAULT_PATH) -> str:
    return Path(path).read_text(encoding="utf-8")


def active_season(text: str) -> int:
    m = ACTIVE_SEASON.search(text)
    if not m:
        raise CatalogError("no 'Active season:' marker found in catalog")
    return int(m.group(1))


def _locate_table(lines: list[str], season: int):
    """Return (header_idx, data_indices, has_placeholder) for a season's table.

    Detection runs over a fence-masked view so the illustrative example is
    ignored; the returned indices are valid against the original ``lines``.
    """
    masked = _mask_fences(lines)
    start = None
    for i, line in enumerate(masked):
        m = SEASON_HEADING.match(line)
        if m and int(m.group(1)) == season:
            start = i
            break
    if start is None:
        raise CatalogError(f"Season {season} not found in catalog")

    header_idx = None
    for i in range(start + 1, len(masked)):
        if SEASON_HEADING.match(masked[i]):
            break
        if _is_table_line(masked[i]) and _is_header(masked[i]):
            header_idx = i
            break
    if header_idx is None:
        raise CatalogError(f"Season {season} has no table")

    data_indices, has_placeholder = [], False
    i = header_idx + 1
    while i < len(masked) and _is_table_line(masked[i]):
        if not _is_separator(masked[i]) and not _is_header(masked[i]):
            data_indices.append(i)
            if _is_placeholder(masked[i]):
                has_placeholder = True
        i += 1
    return header_idx, data_indices, has_placeholder


def rows_for_season(text: str, season: int) -> list[Row]:
    lines = text.splitlines()
    _, data_indices, _ = _locate_table(lines, season)
    out = []
    for idx in data_indices:
        if _is_placeholder(lines[idx]):
            continue
        c = _cells(lines[idx])
        c += [""] * (len(COLUMNS) - len(c))  # pad short rows
        ep = int(c[0]) if c[0].isdigit() else None
        out.append(Row(season, ep, c[1], c[2], c[3], c[4], c[5], c[6], idx))
    return out


def next_episode(text: str, season: int) -> int:
    eps = [r.ep for r in rows_for_season(text, season) if r.ep is not None]
    return (max(eps) + 1) if eps else 1


def _format_row(ep: int, album: str, artist: str, host: str,
                status: str, dir_: str, published: str) -> str:
    return f"| {ep:02d} | {album} | {artist} | {host} | {status} | {dir_} | {published} |"


# --- mutation ----------------------------------------------------------------

def assign(album: str, artist: str, host: str, season: int | None = None,
           path: str | Path = DEFAULT_PATH) -> dict:
    """Claim a matching ``planned`` row or append the next episode.

    Sets the row's status to ``in-production`` and fills its Dir. Returns
    ``{season, episode, dir, action}`` where action is 'claimed' or 'appended'.
    """
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    season = season if season is not None else active_season(text)
    lines = text.splitlines()
    header_idx, data_indices, has_placeholder = _locate_table(lines, season)

    # Look for a matching planned row to claim.
    for r in rows_for_season(text, season):
        if (r.status.lower() == "planned"
                and r.album.lower() == album.lower()
                and r.artist.lower() == artist.lower()):
            ep = r.ep if r.ep is not None else next_episode(text, season)
            d = f"S{season:02d}E{ep:02d}-{slug(album)}"
            lines[r.lineno] = _format_row(ep, r.album, r.artist, host,
                                          "in-production", d, EMPTY)
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return {"season": season, "episode": ep, "dir": d, "action": "claimed"}

    # Otherwise append the next episode.
    ep = next_episode(text, season)
    d = f"S{season:02d}E{ep:02d}-{slug(album)}"
    new_row = _format_row(ep, album, artist, host, "in-production", d, EMPTY)
    if has_placeholder:
        ph = next(i for i in data_indices if _is_placeholder(lines[i]))
        lines[ph] = new_row
    else:
        insert_at = (data_indices[-1] if data_indices else header_idx + 1) + 1
        lines.insert(insert_at, new_row)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"season": season, "episode": ep, "dir": d, "action": "appended"}


def set_status(season: int, ep: int, status: str, published: str | None = None,
               path: str | Path = DEFAULT_PATH) -> None:
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    for r in rows_for_season(text, season):
        if r.ep == ep:
            pub = published if published is not None else r.published
            lines[r.lineno] = _format_row(ep, r.album, r.artist, r.host,
                                          status, r.dir, pub)
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return
    raise CatalogError(f"S{season:02d}E{ep:02d} not found in catalog")


# --- cli ---------------------------------------------------------------------

def run_cli(args) -> int:
    path = Path(args.file) if args.file else DEFAULT_PATH
    text = read(path)
    if args.catalog_cmd == "next":
        season = args.season if args.season is not None else active_season(text)
        print(next_episode(text, season))
    elif args.catalog_cmd == "list":
        season = args.season if args.season is not None else active_season(text)
        rows = rows_for_season(text, season)
        print(f"Season {season} (active={active_season(text)}): {len(rows)} episode(s)")
        for r in rows:
            print(f"  E{r.ep:02d}  {r.status:<14} {r.album} — {r.artist} "
                  f"(host {r.host})  dir={r.dir}  pub={r.published}")
    elif args.catalog_cmd == "assign":
        result = assign(args.album, args.artist, args.host, args.season, path)
        print(f"{result['action']}: S{result['season']:02d}E{result['episode']:02d} "
              f"→ {result['dir']}")
    return 0
