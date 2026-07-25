#!/usr/bin/env bash
#
# Update the pipeline LXC after merging a PR:
#
#   ./scripts/deploy.sh
#   ./scripts/deploy.sh --dry-run
#
# Defaults match the SUB/WAVE pipeline host:
#   ssh root@100.110.0.9
#   pct exec 108
#   /opt/radio-documentaries as user pipeline
#   restart subwave-mcp
#
# Overrides if your setup differs:
#   PROXMOX_HOST=root@192.168.1.10 CTID=108 OWNER=pipeline \
#   REMOTE_DIR=/opt/radio-documentaries SERVICE=subwave-mcp ./scripts/deploy.sh
#
set -euo pipefail

PROXMOX_HOST="${PROXMOX_HOST:-root@100.110.0.9}"
CTID="${CTID:-108}"
OWNER="${OWNER:-pipeline}"
REMOTE_DIR="${REMOTE_DIR:-/opt/radio-documentaries}"
SERVICE="${SERVICE:-subwave-mcp}"
BRANCH="${BRANCH:-}"
SUDO="${SUDO:-}" # set to "sudo" when PROXMOX_HOST is a non-root user (pct requires root)

DRY_RUN=0
RESTART=1

usage() {
  cat <<EOF
usage: $0 [--dry-run] [--no-restart] [--branch <name>]

Environment overrides:
  PROXMOX_HOST  SSH target for the Proxmox host (default: root@100.110.0.9)
  CTID          Pipeline LXC id (default: 108)
  OWNER         Repo owner inside the LXC (default: pipeline)
  REMOTE_DIR    Repo path inside the LXC (default: /opt/radio-documentaries)
  SERVICE       systemd service to restart inside the LXC (default: subwave-mcp)
  SUDO          Optional sudo prefix for pct on the Proxmox host
  BRANCH        Optional branch to check out before pulling
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-restart)
      RESTART=0
      shift
      ;;
    --branch)
      if [[ $# -lt 2 ]]; then
        echo "error: --branch needs a branch name" >&2
        exit 2
      fi
      BRANCH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

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
  run ssh "$PROXMOX_HOST" "$remote"
}

pipeline_shell() {
  local command="$1"
  pct_exec runuser -u "$OWNER" -- bash -lc "$command"
}

echo "Deploying radio-documentaries on $PROXMOX_HOST / CT $CTID"
echo "Repo: $REMOTE_DIR as $OWNER"

if [[ -n "$BRANCH" ]]; then
  echo "Checking out $BRANCH"
  pipeline_shell "cd $(printf '%q' "$REMOTE_DIR") && git fetch origin && git checkout $(printf '%q' "$BRANCH")"
fi

echo "Pulling latest code"
pipeline_shell "cd $(printf '%q' "$REMOTE_DIR") && git pull --ff-only"

if [[ "$RESTART" -eq 1 ]]; then
  echo "Restarting $SERVICE"
  pct_exec systemctl restart "$SERVICE"

  echo "Service status"
  pct_exec systemctl --no-pager --full status "$SERVICE"
else
  echo "Skipping restart (--no-restart)"
fi

echo "Done"
