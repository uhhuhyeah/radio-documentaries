"""Estimate ElevenLabs credit spend for an episode before rendering (flow 6b).

Bills on characters of the SPOKEN text only (SONG slots are Navidrome tracks,
never TTS). Reports both candidate models and checks an optional cap so an
automated run can refuse to blow the shared 30k/mo plan.

Run:  python3 docuflow.py budget path/to/script.md [--cap 15000]
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import scriptmodel
from .scriptmodel import MODEL_CREDIT_RATE

WORDS_PER_MINUTE = 150


@dataclass
class Estimate:
    chars: int
    words: int
    spoken_minutes: float
    credits_by_model: dict          # model -> credits
    chosen_model: str | None
    chosen_credits: float | None


def estimate_text(text: str) -> Estimate:
    ep = scriptmodel.parse(text)
    # Characters as sent to the API: the verbatim spoken body of each SPOKEN slot.
    chars = sum(len(s.body) for s in ep.spoken_slots)
    words = sum(len(s.body.split()) for s in ep.spoken_slots)
    by_model = {m: chars * rate for m, rate in MODEL_CREDIT_RATE.items()}
    chosen = ep.front_matter.get("model")
    return Estimate(
        chars=chars,
        words=words,
        spoken_minutes=words / WORDS_PER_MINUTE,
        credits_by_model=by_model,
        chosen_model=chosen,
        chosen_credits=by_model.get(chosen),
    )


def estimate_file(path: str | Path) -> Estimate:
    return estimate_text(Path(path).read_text(encoding="utf-8"))


def run_cli(path: str, cap: int | None = None) -> int:
    e = estimate_file(path)
    print(f"budget {path}")
    print(f"  spoken text: {e.chars:,} chars / {e.words:,} words / ~{e.spoken_minutes:.0f} min spoken")
    print("  credits by model:")
    for model, credits in e.credits_by_model.items():
        mark = "  <- chosen" if model == e.chosen_model else ""
        print(f"    {model:<24} {credits:>10,.0f} credits{mark}")
    if e.chosen_model and e.chosen_credits is None:
        print(f"  ! chosen model {e.chosen_model!r} has no known credit rate")
    if cap is not None and e.chosen_credits is not None:
        status = "OK" if e.chosen_credits <= cap else "OVER CAP"
        print(f"  cap check: {e.chosen_credits:,.0f} vs cap {cap:,} → {status}")
        return 0 if e.chosen_credits <= cap else 2
    return 0
