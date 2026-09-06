#!/usr/bin/env bash
#
# Pull an episode's rendered narration MP3s off the pipeline LXC to this machine:
#
#   ./scripts/fetch-audio.sh S01E06-home
#   ./scripts/fetch-audio.sh S01E06-home --site
#   ./scripts/fetch-audio.sh --list
#
# The companion to scripts/fetch-script.sh, which handles text files only.
# Audio lands in this repo at <episode>/audio/ — the layout push-audio.sh
# expects — so publishing to R2 is the next command:
#
#   ./scripts/fetch-audio.sh S01E06-home --site
#   (cd ~/code/homelab/radio-documentaries-site && ./push-audio.sh S01E06-home)
#
# Episode working directories are gitignored, so nothing here enters version
# control; this is a local staging area for publishing and for site dev.
#
# Defaults match the SUB/WAVE pipeline host (same as fetch-script.sh):
#   ssh root@100.110.0.9
#   pct exec 108
#   /opt/radio-documentaries as user pipeline
#
set -euo pipefail

PROXMOX_HOST="${PROXMOX_HOST:-root@100.110.0.9}"
CTID="${CTID:-108}"
OWNER="${OWNER:-pipeline}"
REMOTE_DIR="${REMOTE_DIR:-/opt/radio-documentaries}"
SITE_DIR="${SITE_DIR:-$HOME/code/homelab/radio-documentaries-site}"
SUDO="${SUDO:-}" # set to "sudo" when PROXMOX_HOST is a non-root user (pct requires root)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EPISODE=""
DEST=""
SITE=0
LIST=0

usage() {
  cat <<EOF
usage: $0 <episode> [--to <dir>] [--site]
       $0 --list

Arguments:
  <episode>     Episode directory on the LXC, e.g. S01E06-home

Options:
  --list        List episode directories available on the LXC and exit
  --to <dir>    Destination audio directory
                (default: <repo>/<episode>/audio, what push-audio.sh reads)
  --site        Also mirror the MP3s into the site's dev tree at
                \$SITE_DIR/public/audio/<episode-id>/, where <episode-id> is
                the episode name lowercased. That tree is gitignored; it is
                what \`astro dev\` plays before the files reach R2.

Only *.mp3 is copied. Sidecars such as render-manifest.json stay on the LXC —
the site's audio tree must contain nothing but narration.

Existing files are overwritten: a rendered part is never edited in place, so
re-running this is how you pick up a re-render.

Environment overrides:
  PROXMOX_HOST  SSH target for the Proxmox host (default: root@100.110.0.9)
  CTID          Pipeline LXC id (default: 108)
  OWNER         Repo owner inside the LXC (default: pipeline)
  REMOTE_DIR    Repo path inside the LXC (default: /opt/radio-documentaries)
  SITE_DIR      Site repo path for --site (default: ~/code/homelab/radio-documentaries-site)
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
    --site)
      SITE=1
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
  # Deliberate client-side expansion: $remote is already shell-quoted above.
  # shellcheck disable=SC2029
  ssh "$PROXMOX_HOST" "$remote"
}

pipeline_shell() {
  pct_exec runuser -u "$OWNER" -- bash -lc "$1"
}

list_episodes() {
  pipeline_shell "cd $(printf '%q' "$REMOTE_DIR") && ls -d S[0-9][0-9]E[0-9][0-9]-*/ 2>/dev/null | sed 's:/\$::'"
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
EPISODE_ID="$(printf '%s' "$EPISODE" | tr '[:upper:]' '[:lower:]')"
REMOTE_AUDIO="$REMOTE_DIR/$EPISODE/audio"
DEST="${DEST:-$REPO_ROOT/$EPISODE/audio}"

if ! pipeline_shell "test -d $(printf '%q' "$REMOTE_AUDIO")"; then
  echo "error: $REMOTE_AUDIO not found on CT $CTID" >&2
  echo "Available episodes:" >&2
  list_episodes >&2
  exit 1
fi

count=$(pipeline_shell "ls -1 $(printf '%q' "$REMOTE_AUDIO")/*.mp3 2>/dev/null | wc -l" | tr -d ' ')
if [[ "$count" -eq 0 ]]; then
  echo "error: no .mp3 files in $REMOTE_AUDIO — has the episode been rendered?" >&2
  exit 1
fi

echo "Fetching $count MP3s from $EPISODE/audio on CT $CTID"

# Stage into a temp dir so a transfer that dies part-way leaves the existing
# destination untouched rather than half-replaced.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fetch-audio.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# tar over the pct exec pipe: scp/rsync can't reach inside the container, and
# ssh gives a binary-safe stream as long as no tty is allocated.
pipeline_shell "cd $(printf '%q' "$REMOTE_AUDIO") && tar -cf - -- *.mp3" | tar -x -C "$TMP"

got=$(find "$TMP" -name '*.mp3' -type f | wc -l | tr -d ' ')
if [[ "$got" -ne "$count" ]]; then
  echo "error: expected $count MP3s, received $got; leaving $DEST untouched" >&2
  exit 1
fi

install_to() {
  local target="$1"
  mkdir -p "$target"
  find "$TMP" -name '*.mp3' -type f -exec cp {} "$target/" \;
  chmod 644 "$target"/*.mp3
  echo "Wrote $got MP3s to $target"
}

install_to "$DEST"

if [[ "$SITE" -eq 1 ]]; then
  if [[ ! -d "$SITE_DIR" ]]; then
    echo "error: site repo not found at $SITE_DIR (set SITE_DIR)" >&2
    exit 1
  fi
  install_to "$SITE_DIR/public/audio/$EPISODE_ID"
fi

echo
echo "Publish to R2 with:"
echo "  (cd $SITE_DIR && ./push-audio.sh $EPISODE)"
