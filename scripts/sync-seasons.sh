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
# catalog_assign / catalog_set_status WRITE to seasons.md, so it must be owned
# by (writable to) the `pipeline` user — copying as pipeline@ gets that for free.
#
# Override the target if your setup differs:
#   PIPELINE_HOST=pipeline@192.168.1.90 REMOTE_DIR=/opt/radio-documentaries ./scripts/sync-seasons.sh
#
set -euo pipefail

PIPELINE_HOST="${PIPELINE_HOST:-pipeline@192.168.1.90}"
REMOTE_DIR="${REMOTE_DIR:-/opt/radio-documentaries}"

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
rsync -e ssh -av "$LOCAL_FILE" "$PIPELINE_HOST:$REMOTE_FILE"

# Confirm what landed (line count + the season/status header lines).
echo "✓ done. Remote now has:"
ssh "$PIPELINE_HOST" "wc -l < '$REMOTE_FILE' | xargs echo '  lines:'; grep -iE '^#|status' '$REMOTE_FILE' | head -n 5 | sed 's/^/  /'" \
  || echo "  (synced, but the remote read-back failed — check SSH access as $PIPELINE_HOST)"
