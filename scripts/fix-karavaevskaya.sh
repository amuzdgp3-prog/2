#!/usr/bin/env bash
# Караваевская 24: вернуть настоящий аппарат № 109 на точку и убрать дубль № 127 (DECISION-056).
#
# Ничего финансового не меняется: moveMachine только закрывает текущую установку и открывает
# новую, перенося текущий счётчик. Обслуживания, выручка и привязки терминалов не трогаются.
# Запускать из корня репозитория: bash scripts/fix-karavaevskaya.sh
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
API() { curl -sk --resolve 2.apixspb.ru:443:127.0.0.1 "$@"; }

TOKEN=$(API -X POST https://2.apixspb.ru/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

move() { # move <номер аппарата> <id точки> <подпись>
  echo "-> $3"
  API -X POST "https://2.apixspb.ru/api/machines/$1/move" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"locationId\":$2,\"detachTerminal\":false}"
  echo
}

move 109 17 "№ 109 (настоящий аппарат) -> Караваевская 24"
move 127  1 "№ 127 (дубль) -> СПб"

echo
echo "=== как стало ==="
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT p.machine_number, l.name AS точка, p.started_at::date, p.initial_game_counter AS счётчик
FROM machine_placements p JOIN locations l ON l.id = p.location_id
WHERE p.machine_number IN ('109','127') AND p.ended_at IS NULL
ORDER BY p.machine_number;"
