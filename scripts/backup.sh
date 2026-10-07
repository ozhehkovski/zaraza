#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
backup_dir="${BACKUP_DIR:-./backups}"
mkdir -p "$backup_dir"
backup_file="$backup_dir/tracker-$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f "$backup_file.tmp"' EXIT HUP INT TERM
docker compose exec -T postgres pg_dump -U tracker -d tracker -Fc > "$backup_file.tmp"
mv "$backup_file.tmp" "$backup_file"
echo "Backup saved: $backup_file"
