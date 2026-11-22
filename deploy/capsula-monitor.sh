#!/bin/bash
# Capsula's health check on the host, every 5 minutes (capsula-monitor.timer). It checks the container's own health,
# the public address through the tunnel, the newest nightly snapshot and free disk space. A problem seen on two runs
# in a row is reported once through $CAPSULA_ALERT_COMMAND, which reads {"title": …, "body": …} JSON on stdin;
# the recovery is reported once too. Without a command it only logs: journalctl -u capsula-monitor.
# Installed as /usr/local/sbin/capsula-monitor (deploy/README.md).
set -uo pipefail

URL="${CAPSULA_PUBLIC_URL:-https://capsula.fit}"
CONTAINER="${CAPSULA_CONTAINER:-capsula-capsula-1}"
BACKUPS="${CAPSULA_BACKUP_DIR:-/srv/capsula/backups}"
MAX_BACKUP_HOURS="${CAPSULA_MAX_BACKUP_HOURS:-30}"
MIN_FREE_GB="${CAPSULA_MIN_FREE_GB:-2}"
STATE="${CAPSULA_MONITOR_STATE:-/var/lib/capsula-monitor/state}"
mkdir -p "$(dirname "$STATE")"

problems=()
health=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
[ "$health" = healthy ] || problems+=("Container $CONTAINER: $health")
curl -fsS --max-time 15 -o /dev/null "$URL/health" 2>/dev/null || problems+=("$URL/health does not answer")
newest=$(find "$BACKUPS" -maxdepth 1 -name 'capsula-*.tar' -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
if [ -z "$newest" ]; then
  problems+=("No snapshot in $BACKUPS")
elif [ $(( $(date +%s) - ${newest%.*} )) -gt $(( MAX_BACKUP_HOURS * 3600 )) ]; then
  problems+=("The newest snapshot is older than $MAX_BACKUP_HOURS hours")
fi
free_kb=$(df -Pk / | awk 'NR == 2 { print $4 }')
[ "$free_kb" -ge $(( MIN_FREE_GB * 1024 * 1024 )) ] || problems+=("Disk: $(( free_kb / 1024 / 1024 )) GB free")

notify() {
  [ -n "${CAPSULA_ALERT_COMMAND:-}" ] || return 0
  python3 -c 'import json, sys; print(json.dumps({"title": sys.argv[1], "body": sys.argv[2]}))' "$1" "$2" | $CAPSULA_ALERT_COMMAND
}

previous=$(cat "$STATE" 2>/dev/null || echo ok) # ok, failing (seen once) or alerted
if [ ${#problems[@]} -eq 0 ]; then
  if [ "$previous" = alerted ]; then
    notify "Capsula: all checks pass again" "$URL, the container, the snapshot and the disk are fine again." || exit 1
  fi
  echo ok > "$STATE"
  exit 0
fi

body=$(printf '%s\n' "${problems[@]}")
echo "$body"
case "$previous" in
  ok) echo failing > "$STATE" ;;
  failing)
    # Kept as "failing" when sending fails, so the next run tries again.
    notify "Capsula: a check fails" "$body" && echo alerted > "$STATE" ;;
esac
exit 1
