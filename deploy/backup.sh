#!/bin/sh
# Scheduled backups, run by the `backup` service in docker-compose.yml (profile "backup"):
#   docker compose --profile backup up -d backup
# Every BACKUP_INTERVAL_HOURS (default 24) it writes a database dump and a copy of the uploaded files to
# ./backups, and removes backups older than BACKUP_KEEP_DAYS (default 14). Copy ./backups off this machine
# as well: a backup next to the database does not survive a dead disk. Restoring: docs/BACKUP.md.
set -eu

INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
OUT=/backups
mkdir -p "$OUT"

backup_once() {
  stamp="$(date +%Y%m%d-%H%M)"
  # write to a temporary name first, so a half-written file is never mistaken for a good backup
  if pg_dump -h db -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom -f "$OUT/db-$stamp.dump.partial"; then
    mv "$OUT/db-$stamp.dump.partial" "$OUT/db-$stamp.dump"
    echo "$(date -Iseconds) database backup written: db-$stamp.dump"
  else
    rm -f "$OUT/db-$stamp.dump.partial"
    echo "$(date -Iseconds) DATABASE BACKUP FAILED" >&2
  fi
  if tar -czf "$OUT/uploads-$stamp.tar.gz.partial" -C /uploads .; then
    mv "$OUT/uploads-$stamp.tar.gz.partial" "$OUT/uploads-$stamp.tar.gz"
    echo "$(date -Iseconds) uploads backup written: uploads-$stamp.tar.gz"
  else
    rm -f "$OUT/uploads-$stamp.tar.gz.partial"
    echo "$(date -Iseconds) UPLOADS BACKUP FAILED" >&2
  fi
  find "$OUT" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) -mtime +"$KEEP_DAYS" -print -delete
}

if [ "${1:-}" = "--once" ]; then
  backup_once
  exit 0
fi

while true; do
  backup_once
  sleep "$((INTERVAL_HOURS * 3600))"
done
