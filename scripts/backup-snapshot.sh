#!/bin/sh
# Nightly snapshot on the server, installed as /usr/local/sbin/capsula-backup and run by
# capsula-backup.timer: both SQLite databases through SQLite's backup API plus every account folder, in one tar
# with its SHA-256. The recovery Mac pulls and encrypts it (scripts/pull-backup.sh). The server keeps only the
# newest completed snapshot and never removes it before its replacement is complete.
set -eu

data=${CAPSULA_DATA:-/srv/capsula/data}
backup_dir=${CAPSULA_BACKUPS:-/srv/capsula/backups}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="$backup_dir/.capsula-$stamp"
final="$backup_dir/capsula-$stamp.tar"

umask 077
mkdir -p "$backup_dir"
lock="$backup_dir/.backup.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "Another backup is running (or a stale .backup.lock needs inspection)." >&2
  exit 1
fi
cleanup() {
  rm -rf "$work" "$final.tmp" "$final.sha256.tmp"
  rmdir "$lock"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -s "$data/app.sqlite" ]; then
  echo "app.sqlite is missing or empty." >&2
  exit 1
fi
# Room for a second snapshot beside the previous one, plus 1 GiB.
need=$(( $(du -sk "$data" | cut -f1) + 1048576 ))
free=$(df -Pk "$backup_dir" | awk 'NR == 2 { print $4 }')
if [ "$free" -lt "$need" ]; then
  echo "Not enough free space for a snapshot." >&2
  exit 1
fi

mkdir "$work"
for db in app usage; do
  [ -s "$data/$db.sqlite" ] || continue
  sqlite3 "$data/$db.sqlite" ".backup '$work/$db.sqlite'"
  # One self-contained file: the copy leaves WAL mode, so no -wal or -shm files travel with it.
  sqlite3 "$work/$db.sqlite" 'PRAGMA journal_mode=DELETE;' > /dev/null
  rm -f "$work/$db.sqlite-wal" "$work/$db.sqlite-shm"
  if [ "$(sqlite3 "$work/$db.sqlite" 'PRAGMA quick_check;')" != ok ]; then
    echo "$db.sqlite failed its integrity check." >&2
    exit 1
  fi
done
# Each account's JSON store is replaced atomically, so every file in the archive is whole. Thumbnails are a
# cache and are rebuilt on demand.
set --
[ -d "$data/users" ] && set -- "$@" users
[ -d "$data/imports" ] && set -- "$@" imports
if [ "$#" -gt 0 ]; then
  tar -cf "$final.tmp" --exclude='users/*/media/thumbs' --exclude='users/*/jobs' --exclude='users/*.importing' -C "$work" . -C "$data" "$@"
else
  tar -cf "$final.tmp" -C "$work" .
fi
sha256sum "$final.tmp" | cut -d ' ' -f 1 > "$final.sha256.tmp"
mv "$final.tmp" "$final"
mv "$final.sha256.tmp" "$final.sha256"

find "$backup_dir" -maxdepth 1 -type f \( -name 'capsula-*.tar' -o -name 'capsula-*.tar.sha256' \) \
  ! -name "capsula-$stamp.tar" ! -name "capsula-$stamp.tar.sha256" -delete
echo "Snapshot: capsula-$stamp.tar"
