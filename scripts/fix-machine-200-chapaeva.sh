#!/usr/bin/env bash
# Аппарат № 200 (Чапаева 15) — DECISION-062. Владелец завёл его сам через приложение
# (13.09, 21:35) с начальными показателями 25 игр / 15 призов, но дата установки в системе
# указана датой регистрации, а не реальной. Владелец сообщил: реальная установка 18.08,
# затем показания 25.08 (271), 28.08 (377) и 09.09 (923, из таблицы «Шаблон Фёдор» — совпадает
# с исходной нечитаемой строкой без адреса, теперь опознанной).
#
# Дата установки в системе уже исправлена на 2026-08-18 (иначе обслуживание от 25.08 не прошло
# бы проверку «дата раньше установки»). Этот скрипт только создаёт три обслуживания.
#
# Счётчик призов не сообщён владельцем для 25.08/28.08 — оставлен равным начальному (15), не
# растёт: по DECISION-059 счётчик призов не используется в расчётах, но система всё равно
# требует его монотонности, поэтому используется безопасное неснижающееся значение вместо
# гадания. Для 09.09 в таблице был указан приз=10 (меньше 15) — тоже не использован по той же
# причине, оставлено 15 с пояснением в notes.
#
# Запуск из корня репозитория: bash scripts/fix-machine-200-chapaeva.sh
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
API() { curl -sk --resolve 2.apixspb.ru:443:127.0.0.1 "$@"; }
IMGDIR="$(pwd)/.import-fedor-images"

TOKEN=$(API -X POST https://2.apixspb.ru/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

post() {
  local m="$1" date="$2" time="$3" game="$4" prize="$5" toys="$6" note="$7" imgkey="$8"
  local img="$IMGDIR/${imgkey}.png"
  local lid; lid=$(python3 -c 'import uuid;print(uuid.uuid4())')
  local up; up=$(API -X POST https://2.apixspb.ru/api/photos -H "authorization: Bearer $TOKEN" \
    -F "localId=$lid" -F "file=@$img;type=image/png")
  local ok; ok=$(echo "$up" | python3 -c 'import sys,json;print(json.load(sys.stdin)["objectKey"])' 2>/dev/null || echo "")
  if [ -z "$ok" ]; then echo "!! фото не загружено для $imgkey: $up"; return 1; fi
  local payload; payload=$(python3 -c "
import json
print(json.dumps({'localId':'$lid','machineNumber':'$m','technicianId':9,'occurredAt':'${date}T${time}Z',
  'gameCounter':int('$game'),'prizeCounter':int('$prize'),'testGames':1,'toys':$toys,
  'photoObjectKey':'$ok','notes':'$note'}, ensure_ascii=False))
")
  local resp; resp=$(API -X POST https://2.apixspb.ru/api/services -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d "$payload")
  if echo "$resp" | grep -q '"id"'; then echo "OK  $m  $date  счётчик $game"; else echo "!!  $m  $date  ОШИБКА: $resp"; fi
}

post 200 2026-08-25 06:00:00 271 15 '[]' \
  'Показание сообщено владельцем напрямую' 200_2026-08-25
post 200 2026-08-28 06:00:00 377 15 '[]' \
  'Показание сообщено владельцем напрямую' 200_2026-08-28
post 200 2026-09-09 06:00:00 923 15 '[{"toyId":1,"quantity":30},{"toyId":2,"quantity":5},{"toyId":3,"quantity":3}]' \
  'Внесено из таблицы «Шаблон Фёдор» (Чапаева 15, лист за 2026-09-09); счётчик призов оставлен без изменений — не используется в расчётах, DECISION-059' \
  200_2026-09-09

echo
echo "=== линия счётчика 200 ==="
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT occurred_at::date, game_counter, new_games, revenue FROM services WHERE machine_number='200' ORDER BY occurred_at;"
