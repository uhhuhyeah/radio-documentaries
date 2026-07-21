"""Parse an episode ``script.md`` into front matter + ordered slots.

This is the shared foundation for lint, budget, and render. The format contract
lives in ``script-format.md``; this parser is its executable counterpart. It uses
only the stdlib so it runs with a bare ``python3`` (no venv needed).

Front matter is a deliberately-flat YAML block (string / quoted-string / int
values only), so a tiny parser handles it without pulling in PyYAML.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

# --- shared constants (single source of truth for the deterministic stages) ---

# Documentary hosts: persona id -> {display name, ElevenLabs voice id, speed}.
# Values mirror subwave-config; see producer-guide.md "SUB/WAVE Personas".
VOICES = {
    "p_cara": {"name": "Cara", "voice_id": "ZF6FPAbjXT4488VcRRnw", "speed": 1.1},
    "p_jools": {"name": "Jools", "voice_id": "1BUhH8aaMvGMUdGAmWVM", "speed": 1.0},
}

# ElevenLabs credit cost per character, per model (approximate, from the guide).
MODEL_CREDIT_RATE = {
    "eleven_flash_v2_5": 0.5,
    "eleven_multilingual_v2": 1.0,
}

REQUIRED_FRONT_MATTER = [
    "season", "episode", "album", "artist",
    "host", "host_name", "model", "target_minutes", "reference_tracks",
]

# A slot heading:  ## [NN] SPOKEN · label   /   ## [NN] SONG · label
SLOT_HEADING = re.compile(r"^##\s+\[(\d{2})\]\s+(SPOKEN|SONG)\s*·\s*(.+?)\s*$")
# Anything that looks like a slot heading but doesn't fully parse (to catch typos).
SLOT_HEADING_LOOSE = re.compile(r"^##\s+\[")
# A SONG metadata line:  - title: "Kyoto"
META_LINE = re.compile(r"^-\s+(\w+):\s*(.+?)\s*$")


class ScriptError(Exception):
    """Raised for structural problems the parser cannot recover from."""


@dataclass
class Slot:
    index: int
    kind: str          # "SPOKEN" or "SONG"
    label: str
    body: str = ""     # SPOKEN: verbatim TTS text. SONG: raw block text.
    meta: dict = field(default_factory=dict)  # SONG: title/artist/album/note
    lineno: int = 0

    def filename(self, season: int, episode: int) -> str:
        """MP3 filename for a SPOKEN slot (SONG slots produce no file)."""
        return f"s{season:02d}e{episode:02d}_{self.index:02d}_{self.label}.mp3"


@dataclass
class Episode:
    front_matter: dict
    slots: list[Slot]
    path: Path | None = None

    @property
    def spoken_slots(self) -> list[Slot]:
        return [s for s in self.slots if s.kind == "SPOKEN"]

    @property
    def song_slots(self) -> list[Slot]:
        return [s for s in self.slots if s.kind == "SONG"]


def _unquote(v: str) -> str:
    if len(v) >= 2 and v[0] in "\"'" and v[-1] == v[0]:
        return v[1:-1]
    return v


def _coerce(v: str):
    s = v.strip()
    if s and (s.isdigit() or (s[0] == "-" and s[1:].isdigit())):
        return int(s)
    return _unquote(s)


def _strip_inline_comment(v: str) -> str:
    """Drop a trailing ``# comment`` on an unquoted value; leave quoted values alone."""
    v = v.strip()
    if v[:1] in "\"'":
        return v  # quoted: '#' inside is literal
    return v.split("#", 1)[0].strip()


def parse_front_matter(block: str) -> dict:
    fm: dict = {}
    for raw in block.splitlines():
        line = raw.strip()
        if not line or ":" not in line:
            continue
        key, val = line.split(":", 1)
        fm[key.strip()] = _coerce(_strip_inline_comment(val))
    return fm


def _split_front_matter(text: str) -> tuple[str, str]:
    """Return (front_matter_block, body). Body starts after the closing '---'."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return "", text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i]), "\n".join(lines[i + 1:])
    raise ScriptError("front matter opened with '---' but never closed")


def parse(text: str, path: Path | None = None) -> Episode:
    fm_block, body = _split_front_matter(text)
    front_matter = parse_front_matter(fm_block)

    slots: list[Slot] = []
    lines = body.splitlines()
    i = 0
    while i < len(lines):
        m = SLOT_HEADING.match(lines[i])
        if not m:
            i += 1
            continue
        index, kind, label = int(m.group(1)), m.group(2), m.group(3).strip()
        heading_lineno = i + 1
        # Collect body lines until the next slot heading (or EOF).
        i += 1
        chunk: list[str] = []
        while i < len(lines) and not SLOT_HEADING.match(lines[i]):
            chunk.append(lines[i])
            i += 1
        raw_body = "\n".join(chunk).strip()

        slot = Slot(index=index, kind=kind, label=label, lineno=heading_lineno)
        if kind == "SONG":
            for cl in chunk:
                mm = META_LINE.match(cl.strip())
                if mm:
                    slot.meta[mm.group(1).lower()] = _unquote(mm.group(2).strip())
        else:
            slot.body = raw_body
        slots.append(slot)

    return Episode(front_matter=front_matter, slots=slots, path=path)


def load(path: str | Path) -> Episode:
    p = Path(path)
    return parse(p.read_text(encoding="utf-8"), path=p)


def find_malformed_headings(text: str) -> list[tuple[int, str]]:
    """Lines that start like a slot heading but don't parse — likely typos."""
    _, body = _split_front_matter(text)
    out = []
    for n, line in enumerate(body.splitlines(), start=1):
        if SLOT_HEADING_LOOSE.match(line) and not SLOT_HEADING.match(line):
            out.append((n, line.rstrip()))
    return out
