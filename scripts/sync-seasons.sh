#!/usr/bin/env bash
#
# Sync seasons.md between this repo and the pipeline LXC (CTID 108), which owns the
# live catalog — the catalog_* tools MUTATE it there (status flips to in-production
# / recorded / published), so the LXC copy is the source of truth and your local
# one drifts. Workflow: pull first, edit, push back.
#
#   ./scripts/sync-seasons.sh pull    # LXC → local (refresh your copy before editing)
#   ./scripts/sync-seasons.sh push    # local → LXC (default; send your edits back)
#   ./scripts/sync-seasons.sh         # same as push
#
# 108 is NOT directly SSH-able. The way in is two hops, the same path you use by
# hand: SSH to the Proxmox host (your key works there), then `pct exec 108`. On
# PUSH the file is written INSIDE 108 as the `pipeline` user (via runuser), so it's
# owned by pipeline and the catalog_* writes keep working — no temp file, no chown.
# The catalog tools read seasons.md fresh per call, so no service restart is needed.
#
# Overrides if your setup differs:
#   PROXMOX_HOST=admin@192.168.1.10 SUDO=sudo   # non-root Proxmox login (pct needs root)
#   CTID=108  OWNER=pipeline  REMOTE_DIR=/opt/radio-documentaries
#
set -euo pipefail

DIRECTION="${1:-push}"
PROXMOX_HOST="${PROXMOX_HOST:-root@192.168.1.10}"
CTID="${CTID:-108}"
OWNER="${OWNER:-pipeline}"
REMOTE_DIR="${REMOTE_DIR:-/opt/radio-documentaries}"
SUDO="${SUDO:-}"  # set to "sudo" when PROXMOX_HOST is a non-root user (pct requires root)

# Resolve the repo root from this script's location, so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_FILE="$SCRIPT_DIR/../seasons.md"
REMOTE_FILE="$REMOTE_DIR/seasons.md"

case "$DIRECTION" in
  pull)
    echo "← pulling seasons.md ← pct exec $CTID ← $PROXMOX_HOST → $LOCAL_FILE"
    # Fetch to a temp file first, then move into place — so a failed fetch never
    # truncates your local copy (redirect would open+truncate before ssh runs).
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    ssh "$PROXMOX_HOST" "$SUDO pct exec $CTID -- cat \"$REMOTE_FILE\"" > "$tmp"
    if [[ ! -s "$tmp" ]]; then
      echo "error: fetched an empty file — leaving your local copy untouched" >&2
      exit 1
    fi
    mv "$tmp" "$LOCAL_FILE"
    trap - EXIT
    echo "✓ done. Local now has: $(wc -l < "$LOCAL_FILE" | tr -d ' ') lines"
    ;;

  push)
    if [[ ! -f "$LOCAL_FILE" ]]; then
      echo "error: no seasons.md at $LOCAL_FILE — nothing to push" >&2
      exit 1
    fi
    echo "→ pushing seasons.md → $PROXMOX_HOST → pct exec $CTID → $REMOTE_FILE (as $OWNER)"
    # Pipe the local file over the hop and write it as the pipeline user:
    # stdin flows ssh → pct exec → runuser → `cat >` inside 108.
    ssh "$PROXMOX_HOST" \
      "$SUDO pct exec $CTID -- runuser -u $OWNER -- sh -c 'cat > \"$REMOTE_FILE\"'" \
      < "$LOCAL_FILE"
    echo "✓ done. Remote now has:"
    ssh "$PROXMOX_HOST" \
      "$SUDO pct exec $CTID -- sh -c 'ls -l \"$REMOTE_FILE\"; wc -l \"$REMOTE_FILE\"'" \
      || echo "  (pushed, but the read-back failed — check the pct exec path)"
    ;;

  *)
    echo "usage: $0 [pull|push]   (default: push)" >&2
    exit 2
    ;;
esac
