#!/usr/bin/env python3
"""docuflow — CLI for the SUB/WAVE radio-documentaries pipeline.

Deterministic stages (built): catalog, lint, budget, navidrome.
Pending stages (need secrets / a runtime): render, research, write, run.

Usage:
  python3 docuflow.py catalog next [--season N] [--file seasons.md]
  python3 docuflow.py catalog list [--season N]
  python3 docuflow.py catalog assign --album A --artist B --host Jools [--season N]
  python3 docuflow.py lint   path/to/script.md
  python3 docuflow.py budget path/to/script.md [--cap 15000]
  python3 docuflow.py navidrome ping
  python3 docuflow.py navidrome find-album --album A [--artist B]
  python3 docuflow.py navidrome album-songs --id ALBUM_ID
  python3 docuflow.py navidrome scan-status
"""

from __future__ import annotations

import argparse
import sys

from pipeline import budget, catalog, lint, navidrome


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

    n = sub.add_parser("navidrome", help="Subsonic client (needs .env)")
    n.add_argument("navidrome_cmd", choices=["ping", "find-album", "album-songs", "scan-status"])
    n.add_argument("--album")
    n.add_argument("--artist")
    n.add_argument("--id")

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
    if args.cmd == "navidrome":
        if args.navidrome_cmd == "find-album" and not args.album:
            print("find-album requires --album", file=sys.stderr)
            return 2
        if args.navidrome_cmd == "album-songs" and not args.id:
            print("album-songs requires --id", file=sys.stderr)
            return 2
        try:
            return navidrome.run_cli(args)
        except navidrome.SubsonicError as e:
            print(f"navidrome error: {e}", file=sys.stderr)
            return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
