"""Validate a ``script.md`` against the format contract (``script-format.md``).

This is the deterministic gate on the Writer Agent's output (flow step 4b): the
script must pass before it goes to render. Errors block; warnings inform.

Run:  python3 docuflow.py lint path/to/script.md
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from . import scriptmodel
from .scriptmodel import MODEL_CREDIT_RATE, REQUIRED_FRONT_MATTER, VOICES

WORDS_PER_MINUTE = 150  # matches script-format.md duration math
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

ERROR, WARN = "ERROR", "WARN"


@dataclass
class Finding:
    level: str
    msg: str

    def __str__(self) -> str:
        return f"  [{self.level}] {self.msg}"


def lint_text(text: str) -> list[Finding]:
    out: list[Finding] = []

    # 0. Malformed slot headings (typos that would silently drop a slot).
    for lineno, line in scriptmodel.find_malformed_headings(text):
        out.append(Finding(ERROR, f"line {lineno}: malformed slot heading: {line!r}"))

    ep = scriptmodel.parse(text)
    fm = ep.front_matter

    # 1. Front matter completeness.
    for key in REQUIRED_FRONT_MATTER:
        if key not in fm:
            out.append(Finding(ERROR, f"front matter missing required key: {key}"))

    # 2. Host + host_name coherence.
    host = fm.get("host")
    if host is not None and host not in VOICES:
        out.append(Finding(ERROR, f"host {host!r} is not a documentary persona {list(VOICES)}"))
    elif host in VOICES and fm.get("host_name") not in (None, VOICES[host]["name"]):
        out.append(Finding(
            WARN, f"host_name {fm.get('host_name')!r} != persona name {VOICES[host]['name']!r}"))

    # 3. Model.
    model = fm.get("model")
    if model is not None and model not in MODEL_CREDIT_RATE:
        out.append(Finding(WARN, f"model {model!r} not in known set {list(MODEL_CREDIT_RATE)}"))

    # 4. Slots exist.
    if not ep.slots:
        out.append(Finding(ERROR, "no slots found"))
        return out

    # 5. Indices contiguous 1..N, no dups (spoken + song share one sequence).
    indices = [s.index for s in ep.slots]
    expected = list(range(1, len(indices) + 1))
    if indices != expected:
        out.append(Finding(
            ERROR, f"slot indices must be contiguous {expected}, got {indices}"))

    # 6. First slot should be SPOKEN (an episode can't open on a song).
    if ep.slots[0].kind != "SPOKEN":
        out.append(Finding(WARN, "first slot is not SPOKEN (expected an intro)"))

    # 7. Per-slot checks.
    for s in ep.slots:
        if not KEBAB.match(s.label):
            out.append(Finding(WARN, f"slot {s.index:02d}: label {s.label!r} is not kebab-case"))
        if s.kind == "SPOKEN":
            if not s.body.strip():
                out.append(Finding(ERROR, f"slot {s.index:02d} ({s.label}): SPOKEN body is empty"))
        else:  # SONG
            if "title" not in s.meta:
                out.append(Finding(ERROR, f"slot {s.index:02d} ({s.label}): SONG missing 'title'"))
            for optional in ("artist", "album"):
                if optional not in s.meta:
                    out.append(Finding(
                        WARN, f"slot {s.index:02d} ({s.label}): SONG missing '{optional}'"))

    # 8. reference_tracks count matches SONG slots, and is in 1..3.
    n_songs = len(ep.song_slots)
    declared = fm.get("reference_tracks")
    if isinstance(declared, int) and declared != n_songs:
        out.append(Finding(
            ERROR, f"reference_tracks={declared} but found {n_songs} SONG slot(s)"))
    if not (1 <= n_songs <= 3):
        out.append(Finding(WARN, f"{n_songs} reference songs (script-format.md expects 1-3)"))

    # 9. Soft duration sanity: spoken minutes alone shouldn't blow the target.
    words = sum(len(s.body.split()) for s in ep.spoken_slots)
    spoken_min = words / WORDS_PER_MINUTE
    target = fm.get("target_minutes")
    if isinstance(target, int):
        if spoken_min > target:
            out.append(Finding(
                WARN, f"spoken content ~{spoken_min:.0f} min already exceeds "
                      f"target_minutes={target} (songs add more)"))
        elif spoken_min < target * 0.4:
            out.append(Finding(
                WARN, f"spoken content ~{spoken_min:.0f} min is thin for "
                      f"target_minutes={target}"))

    return out


def lint_file(path: str | Path) -> list[Finding]:
    return lint_text(Path(path).read_text(encoding="utf-8"))


def run_cli(path: str) -> int:
    findings = lint_file(path)
    errors = [f for f in findings if f.level == ERROR]
    warns = [f for f in findings if f.level == WARN]
    print(f"lint {path}")
    if not findings:
        print("  OK — no issues")
    for f in findings:
        print(f)
    print(f"  → {len(errors)} error(s), {len(warns)} warning(s)")
    return 1 if errors else 0
