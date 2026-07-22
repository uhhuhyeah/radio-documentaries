#!/usr/bin/env bash
#
# Sync the local (gitignored) seasons.md to the pipeline LXC so the catalog
# tools can read/write it. Run this from your Mac whenever you edit seasons.md.
#
#   ./scripts/sync-seasons.sh
#
# The file lands on the PIPELINE LXC (CTID 108) — that's where the MCP server
# runs the catalog_* tools. Hermes (LXC 105) never reads it directly. The
# catalog tools read the file fresh on every call, so no service restart is
# needed; the next catalog_* call picks it up.
#
# We connect as root (key-based — the `pipeline` service user has no authorized
# key, which is why connecting as it prompted for a password). But catalog_assign
# / catalog_set_status WRITE to seasons.md AS the pipeline user, so after copying
# we chown the file to pipeline — otherwise a root-owned file would break those
# writes with EACCES.
#
# Overrides:
#   PIPELINE_HOST=admin@192.168.1.90 SUDO=sudo ./scripts/sync-seasons.sh   # non-root login
#   REMOTE_DIR=/opt/radio-documentaries  OWNER=pipeline                    # if paths/user differ
#
set -euo pipefail

PIPELINE_HOST="${PIPELINE_HOST:-root@192.168.1.90}"
REMOTE_DIR="${REMOTE_DIR:-/opt/radio-documentaries}"
OWNER="${OWNER:-pipeline}"
SUDO="${SUDO:-}"  # set to "sudo" when logging in as a non-root user (e.g. admin@)

# Resolve the repo root from this script's location, so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_FILE="$SCRIPT_DIR/../seasons.md"

if [[ ! -f "$LOCAL_FILE" ]]; then
  echo "error: no seasons.md at $LOCAL_FILE — nothing to sync" >&2
  exit 1
fi

REMOTE_FILE="$REMOTE_DIR/seasons.md"
echo "→ syncing seasons.md to $PIPELINE_HOST:$REMOTE_FILE"

# rsync over ssh: fast, shows what changed, creates nothing but the file.
# With SUDO set (non-root login), run the remote rsync under sudo so it can write REMOTE_DIR.
RSYNC_ARGS=(-e ssh -av)
[[ -n "$SUDO" ]] && RSYNC_ARGS+=(--rsync-path="$SUDO rsync")
rsync "${RSYNC_ARGS[@]}" "$LOCAL_FILE" "$PIPELINE_HOST:$REMOTE_FILE"

# Hand the file to the service user so the catalog_* tools can write it back.
ssh "$PIPELINE_HOST" "$SUDO chown $OWNER '$REMOTE_FILE'"

# Confirm what landed (owner + line count + the season/status header lines).
echo "✓ done. Remote now has:"
ssh "$PIPELINE_HOST" "ls -l '$REMOTE_FILE' | awk '{print \"  owner:\", \$3}'; wc -l < '$REMOTE_FILE' | xargs echo '  lines:'; grep -iE '^#|status' '$REMOTE_FILE' | head -n 5 | sed 's/^/  /'" \
  || echo "  (synced, but the remote read-back failed — check SSH access as $PIPELINE_HOST)"
