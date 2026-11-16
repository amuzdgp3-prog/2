#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export_dir="$project_dir/backups/hourly"
mkdir -p "$export_dir"
exec 9>"$export_dir/.export.lock"
flock -n 9

snapshot="$(mktemp "$export_dir/.snapshot.XXXXXXXX")"
trap 'rm -f -- "$snapshot"' EXIT
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' site2-db)" = "$project_dir"
docker exec site2-db pg_dump -U apixspb -d apixspb --format=custom --no-owner --no-privileges \
  --lock-wait-timeout=10s > "$snapshot"
docker exec -i site2-db pg_restore --list < "$snapshot" > /dev/null
mv -f -- "$snapshot" "$export_dir/site2-latest.dump"
printf 'Опубликован почасовой снимок базы (%s байт)\n' "$(stat -c %s "$export_dir/site2-latest.dump")"
