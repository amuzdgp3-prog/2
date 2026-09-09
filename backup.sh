#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/s/Work/sites/2"
BACKUP_DIR="$PROJECT_DIR/backups"
KEEP_DAYS=30
STAMP="$(date +%Y-%m-%d_%H-%M)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$BACKUP_DIR"

docker exec site2-db pg_dump -U apixspb -d apixspb --format=custom --file=/tmp/db.dump
docker cp site2-db:/tmp/db.dump "$WORKDIR/db.dump"
docker exec site2-db rm -f /tmp/db.dump

ARCHIVE="$BACKUP_DIR/apixspb-backup-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$WORKDIR" db.dump -C "$PROJECT_DIR/data" photos

find "$BACKUP_DIR" -name 'apixspb-backup-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

if command -v rclone >/dev/null 2>&1 && rclone listremotes | grep -q '^gdrive:'; then
  rclone copy "$ARCHIVE" gdrive:apixspb-backups --quiet
  echo "$(date -Is) uploaded $ARCHIVE" >> "$BACKUP_DIR/backup.log"
else
  echo "$(date -Is) rclone remote 'gdrive' not configured yet, skipped upload for $ARCHIVE" >> "$BACKUP_DIR/backup.log"
fi
