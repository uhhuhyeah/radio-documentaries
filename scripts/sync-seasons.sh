#!/usr/bin/env bash
#
# Sync the local (gitignored) seasons.md to the pipeline LXC so the catalog
# tools can read/write it. Run this from your Mac whenever you edit seasons.md.
#
#   ./scripts/sync-seasons.sh
#
# The pipeline LXC (CTID 108) is NOT directly SSH-able. The way in is two hops,
# the same path you use by hand: SSH to the Proxmox host (your key works there),
# then `pct exec 108` into the container. So this pipes the file over that hop and
# writes it INSIDE 108 as the `pipeline` user (via runuser) — so the file is owned
# by pipeline automatically, and catalog_assign / catalog_set_status (which write
# seasons.md as that user) keep working. No temp file, no chown.
#
# The catalog tools read seasons.md fresh on every call, so no service restart is
# needed; the next catalog_* call picks it up.
#
# Overrides if your setup differs:
#   PROXMOX_HOST=admin@192.168.1.10 SUDO=sudo   # non-root Proxmox login (pct needs root)
#   CTID=108  OWNER=pipeline  REMOTE_DIR=/opt/radio-documentaries
#
set -euo pipefail

PROXMOX_HOST="${PROXMOX_HOST:-root@192.168.1.10}"
CTID="${CTID:-108}"
OWNER="${OWNER:-pipeline}"
REMOTE_DIR="${REMOTE_DIR:-/opt/radio-documentaries}"
SUDO="${SUDO:-}"  # set to "sudo" when PROXMOX_HOST is a non-root user (pct requires root)

# Resolve the repo root from this script's location, so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_FILE="$SCRIPT_DIR/../seasons.md"

if [[ ! -f "$LOCAL_FILE" ]]; then
  echo "error: no seasons.md at $LOCAL_FILE — nothing to sync" >&2
  exit 1
fi

REMOTE_FILE="$REMOTE_DIR/seasons.md"
echo "→ syncing seasons.md → $PROXMOX_HOST → pct exec $CTID → $REMOTE_FILE (as $OWNER)"

# Pipe the local file over the SSH hop into the container, written as the pipeline
# user: stdin flows ssh → pct exec → runuser → `cat >` inside 108.
ssh "$PROXMOX_HOST" \
  "$SUDO pct exec $CTID -- runuser -u $OWNER -- sh -c 'cat > \"$REMOTE_FILE\"'" \
  < "$LOCAL_FILE"

# Confirm what landed (owner:group from ls, plus the line count).
echo "✓ done. Remote now has:"
ssh "$PROXMOX_HOST" \
  "$SUDO pct exec $CTID -- sh -c 'ls -l \"$REMOTE_FILE\"; wc -l \"$REMOTE_FILE\"'" \
  || echo "  (synced, but the read-back failed — check the pct exec path)"
