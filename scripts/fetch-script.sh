#!/usr/bin/env bash
#
# Pull a rendered episode script off the pipeline LXC to this machine:
#
#   ./scripts/fetch-script.sh S01E03-weathervanes
#   ./scripts/fetch-script.sh S01E03-weathervanes --to ~/Downloads
#   ./scripts/fetch-script.sh --list
#
# Episode working directories are local-only on the LXC (gitignored, never
# pushed), so this is the way to get a script back onto the Mac for editing,
# publishing, or archiving.
#
# Defaults match the SUB/WAVE pipeline host (same as deploy.sh):
#   ssh root@100.110.0.9
#   pct exec 108
#   /opt/radio-documentaries as user pipeline
#
# Overrides if your setup differs:
#   PROXMOX_HOST=root@192.168.1.10 CTID=108 OWNER=pipeline \
#   REMOTE_DIR=/opt/radio-documentaries ./scripts/fetch-script.sh S01E03-weathervanes
#
set -euo pipefail

PROXMOX_HOST="${PROXMOX_HOST:-root@100.110.0.9}"
CTID="${CTID:-108}"
OWNER="${OWNER:-pipeline}"
REMOTE_DIR="${REMOTE_DIR:-/opt/radio-documentaries}"
SUDO="${SUDO:-}" # set to "sudo" when PROXMOX_HOST is a non-root user (pct requires root)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EPISODE=""
DEST="$REPO_ROOT"
FILE="script.md"
LIST=0
FORCE=0

usage() {
  cat <<EOF
usage: $0 <episode> [--to <dir>] [--file <name>] [--force]
       $0 --list

Arguments:
  <episode>     Episode directory on the LXC, e.g. S01E03-weathervanes

Options:
  --list        List episode directories available on the LXC and exit
  --to <dir>    Destination directory (default: the repo root, $REPO_ROOT)
  --file <name> File to pull from the episode dir (default: script.md;
                e.g. research.md, rundown.json)
  --force       Overwrite the destination file if it already exists

The file lands as <episode>-<file> (e.g. S01E03-weathervanes-script.md) so
several episodes can sit side by side without clobbering each other.

Environment overrides:
  PROXMOX_HOST  SSH target for the Proxmox host (default: root@100.110.0.9)
  CTID          Pipeline LXC id (default: 108)
  OWNER         Repo owner inside the LXC (default: pipeline)
  REMOTE_DIR    Repo path inside the LXC (default: /opt/radio-documentaries)
  SUDO          Optional sudo prefix for pct on the Proxmox host
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)
      LIST=1
      shift
      ;;
    --to)
      if [[ $# -lt 2 ]]; then
        echo "error: --to needs a directory" >&2
        exit 2
      fi
      DEST="$2"
      shift 2
      ;;
    --file)
      if [[ $# -lt 2 ]]; then
        echo "error: --file needs a file name" >&2
        exit 2
      fi
      FILE="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$EPISODE" ]]; then
        echo "error: unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      EPISODE="$1"
      shift
      ;;
  esac
done

pct_exec() {
  local cmd=()
  if [[ -n "$SUDO" ]]; then
    # Intentional word split so SUDO="sudo -n" works.
    read -r -a sudo_parts <<< "$SUDO"
    cmd+=("${sudo_parts[@]}")
  fi
  cmd+=(pct exec "$CTID" -- "$@")

  local remote=""
  printf -v remote "%q " "${cmd[@]}"
  remote="${remote% }"
  ssh "$PROXMOX_HOST" "$remote"
}

pipeline_shell() {
  pct_exec runuser -u "$OWNER" -- bash -lc "$1"
}

list_episodes() {
  pipeline_shell "cd $(printf '%q' "$REMOTE_DIR") && ls -d S[0-9][0-9]E[0-9][0-9]-*/ 2>/dev/null | sed 's:/$::'"
}

if [[ "$LIST" -eq 1 ]]; then
  echo "Episodes on $PROXMOX_HOST / CT $CTID:$REMOTE_DIR"
  list_episodes
  exit 0
fi

if [[ -z "$EPISODE" ]]; then
  echo "error: no episode given" >&2
  usage >&2
  exit 2
fi

# Trailing slash is easy to pick up from tab-completion; drop it.
EPISODE="${EPISODE%/}"

if [[ ! -d "$DEST" ]]; then
  echo "error: destination is not a directory: $DEST" >&2
  exit 1
fi

REMOTE_PATH="$REMOTE_DIR/$EPISODE/$FILE"
OUT="$DEST/$EPISODE-$FILE"

if [[ -e "$OUT" && "$FORCE" -ne 1 ]]; then
  echo "error: $OUT already exists (use --force to overwrite)" >&2
  exit 1
fi

echo "Fetching $EPISODE/$FILE from CT $CTID"

if ! pipeline_shell "test -f $(printf '%q' "$REMOTE_PATH")"; then
  echo "error: $REMOTE_PATH not found on CT $CTID" >&2
  echo "Available episodes:" >&2
  list_episodes >&2
  exit 1
fi

TMP="$(mktemp "${TMPDIR:-/tmp}/fetch-script.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

pipeline_shell "cat $(printf '%q' "$REMOTE_PATH")" > "$TMP"

if [[ ! -s "$TMP" ]]; then
  echo "error: fetched an empty file; leaving $OUT untouched" >&2
  exit 1
fi

mv "$TMP" "$OUT"
trap - EXIT
chmod 644 "$OUT"

echo "Wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
