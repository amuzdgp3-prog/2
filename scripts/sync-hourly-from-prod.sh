#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test "$project_dir" != /opt/sites/2
test -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}"
: "${SITE2_PROD_INTERFACE:?нужен физический сетевой интерфейс до прода}"
remote="${SITE2_PROD_SSH:-root@185.147.82.69}"
key="${SITE2_PROD_SYNC_KEY:-$HOME/.ssh/apixspb_sync}"
[[ "$SITE2_PROD_INTERFACE" =~ ^[[:alnum:]_.-]+$ && "$key" =~ ^/[[:alnum:]_./-]+$ ]]
ssh_command="ssh -B $SITE2_PROD_INTERFACE -i $key -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8"

sync_dir="$project_dir/backups/from-prod/hourly"
mkdir -p "$sync_dir" "$project_dir/data/photos/services"
exec 9>"$sync_dir/.sync.lock"
flock -n 9
snapshot="$sync_dir/site2-latest.dump"

# The forced command on prod only permits sender mode with rsync short options and a relative path.
timeout 90s rsync -t -e "$ssh_command" "$remote:backups/hourly/site2-latest.dump" "$snapshot"
timeout 240s rsync -rt --ignore-existing -e "$ssh_command" "$remote:data/photos/services/" "$project_dir/data/photos/services/"

checksum="$(sha256sum "$snapshot" | cut -d ' ' -f 1)"
if [[ -f "$sync_dir/applied.sha256" && "$(cat "$sync_dir/applied.sha256")" == "$checksum" ]]; then
  printf 'Фото синхронизированы, снимок базы уже применён\n'
  exit 0
fi

for container in site2-db site2-api; do
  test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")" = "$project_dir"
done
test "$(docker context show)" = default

db() { docker exec site2-db psql -Xq -U apixspb -v ON_ERROR_STOP=1 "$@"; }
staging=apixspb_hourly_staging
previous=apixspb_hourly_previous
# Restore into a separate local database. The live local API keeps serving the previous snapshot.
db -d postgres -c "DROP DATABASE IF EXISTS $staging"
db -d postgres -c "CREATE DATABASE $staging TEMPLATE template0 OWNER apixspb"
docker exec -i site2-db pg_restore -U apixspb -d "$staging" --exit-on-error --no-owner --no-privileges < "$snapshot"
db -d "$staging" -c 'UPDATE parser_settings SET is_enabled = false'
test "$(db -d "$staging" -Atc 'SELECT count(*) > 0 FROM services')" = t
db -d "$staging" -c 'SELECT 1 FROM counter_photo_checks LIMIT 0' > /dev/null

api_was_running="$(docker inspect -f '{{.State.Running}}' site2-api)"
restore_api() {
  if [[ "$api_was_running" == true ]]; then docker start site2-api > /dev/null; fi
}
trap restore_api EXIT
if [[ "$api_was_running" == true ]]; then docker stop site2-api > /dev/null; fi
db -d postgres -c "DROP DATABASE IF EXISTS $previous"
db -d postgres -c "BEGIN; ALTER DATABASE apixspb RENAME TO $previous; ALTER DATABASE $staging RENAME TO apixspb; COMMIT"
restore_api
trap - EXIT

local_api_healthy() {
  for _ in {1..20}; do
    if timeout 2s docker exec site2-api node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if [[ "$api_was_running" == true ]] && ! local_api_healthy; then
  docker stop site2-api > /dev/null
  trap restore_api EXIT
  db -d postgres -c "BEGIN; ALTER DATABASE apixspb RENAME TO $staging; ALTER DATABASE $previous RENAME TO apixspb; COMMIT"
  printf 'Локальный API не прошёл проверку, возвращён предыдущий снимок\n' >&2
  exit 1
fi

printf '%s\n' "$checksum" > "$sync_dir/applied.sha256"
printf 'Локальная база обновлена; фото счётчиков синхронизированы\n'
