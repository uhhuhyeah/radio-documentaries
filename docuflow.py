#!/usr/bin/env python3
"""docuflow — CLI for the SUB/WAVE radio-documentaries pipeline.

Deterministic stages (built): catalog, lint, budget.
Pending stages (need secrets / a runtime): navidrome, render, research, write, run.

Usage:
  python3 docuflow.py catalog next [--season N] [--file seasons.md]
  python3 docuflow.py catalog list [--season N]
  python3 docuflow.py catalog assign --album A --artist B --host Jools [--season N]
  python3 docuflow.py lint   path/to/script.md
  python3 docuflow.py budget path/to/script.md [--cap 15000]
"""

from __future__ import annotations

import argparse
import sys

from pipeline import budget, catalog, lint


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="docuflow", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("catalog", help="read/update seasons.md")
    c.add_argument("catalog_cmd", choices=["next", "list", "assign"])
    c.add_argument("--season", type=int, default=None)
    c.add_argument("--album")
    c.add_argument("--artist")
    c.add_argument("--host")
    c.add_argument("--file", help="catalog path (default: seasons.md)")

    l = sub.add_parser("lint", help="validate a script.md against the format")
    l.add_argument("script")

    b = sub.add_parser("budget", help="estimate ElevenLabs credits for a script")
    b.add_argument("script")
    b.add_argument("--cap", type=int, default=None, help="fail if chosen model exceeds this")

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "catalog":
        if args.catalog_cmd == "assign" and not (args.album and args.artist and args.host):
            print("assign requires --album, --artist, --host", file=sys.stderr)
            return 2
        return catalog.run_cli(args)
    if args.cmd == "lint":
        return lint.run_cli(args.script)
    if args.cmd == "budget":
        return budget.run_cli(args.script, args.cap)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
