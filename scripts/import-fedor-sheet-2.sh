#!/usr/bin/env bash
# Второй бланк Фёдора (DECISION-065): 11 обслуживаний.
#
# На бланке внизу от руки написано «4.09», но эта дата не сходится с одним из аппаратов —
# № 115 (Сертолово, Ларина 12а) установлен в системе только 06.09 с базой 20, а на бланке для
# него читается показание 271. Показание после установки, а не до неё, физически возможно
# только если сама дата бланка — 09.09, а не 04.09. Проверка подтверждает: рост 251 игра за
# 3 дня (84 игры/сутки) для этого аппарата ровно на медиане по парку. Остальные десять адресов
# при дате 09.09 тоже дают правдоподобный темп (22–99 игр/сутки, все в пределах нормы), поэтому
# вся форма принята с датой 09.09. Запись «4.09» внизу бланка, скорее всего, относится к какой-то
# другой заметке технику («Прогон 120-171. 5000+1260...»), не к дате этой таблицы.
#
# Адреса «Сестрорецк, Воскова, 10» (машина 33) и «Сярьги, Центральная 25а» (машина 116, новый
# аппарат без истории) на бланке пустые — обслуживания не было, не заводятся.
#
# «Охтинская территория здание 1» (1136/11) в систему не заведён вообще — адрес не найден,
# нужно уточнение владельца, в этот скрипт не входит.
#
# Запуск из корня репозитория: bash scripts/import-fedor-sheet-2.sh
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
  local m="$1" time="$2" game="$3" prize="$4" test="$5" toys="$6"
  local img="$IMGDIR/${m}_2026-09-09.png"
  local lid; lid=$(python3 -c 'import uuid;print(uuid.uuid4())')
  local up; up=$(API -X POST https://2.apixspb.ru/api/photos -H "authorization: Bearer $TOKEN" \
    -F "localId=$lid" -F "file=@$img;type=image/png")
  local ok; ok=$(echo "$up" | python3 -c 'import sys,json;print(json.load(sys.stdin)["objectKey"])' 2>/dev/null || echo "")
  if [ -z "$ok" ]; then echo "!! фото не загружено для $m: $up"; return 1; fi
  local payload; payload=$(python3 -c "
import json
print(json.dumps({'localId':'$lid','machineNumber':'$m','technicianId':9,'occurredAt':'2026-09-09T${time}Z',
  'gameCounter':int('$game'),'prizeCounter':int('$prize'),'testGames':int('$test'),'toys':$toys,
  'photoObjectKey':'$ok','notes':'Бланк техника Фёдора; дата на бланке 04.09 не сходится с установкой аппарата, принято 09.09 (см. DECISION-065)'}, ensure_ascii=False))
")
  local resp; resp=$(API -X POST https://2.apixspb.ru/api/services -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d "$payload")
  if echo "$resp" | grep -q '"id"'; then echo "OK  $m  счётчик $game"; else echo "!!  $m  ОШИБКА: $resp"; fi
}

# post 32 запущен отдельно вручную из-за архивной заглушки счётчика призов (8581), см. DECISION-065
post 24  06:15:00 25962 1413 1 '[{"toyId":1,"quantity":12}]'
post 25  06:30:00 19748 1940 1 '[{"toyId":2,"quantity":2},{"toyId":1,"quantity":30}]'
post 23  06:45:00 16671 1594 1 '[{"toyId":2,"quantity":2},{"toyId":1,"quantity":30}]'
post 22  07:00:00 22449 1218 1 '[]'
post 21  07:15:00 16356 1536 1 '[{"toyId":2,"quantity":2},{"toyId":1,"quantity":2}]'
post 68  07:30:00 9316  41   1 '[{"toyId":2,"quantity":2},{"toyId":1,"quantity":30}]'
post 66  07:45:00 8028  51   1 '[{"toyId":2,"quantity":2}]'
post 88  08:00:00 7616  30   1 '[]'
post 72  08:15:00 9458  70   1 '[{"toyId":2,"quantity":3},{"toyId":1,"quantity":60}]'
post 115 08:30:00 271   10   1 '[{"toyId":2,"quantity":6},{"toyId":1,"quantity":30}]'

echo
echo "=== итог: сколько обслуживаний за 09.09 у Фёдора теперь ==="
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT machine_number, game_counter, revenue FROM services
WHERE technician_id=9 AND occurred_at::date='2026-09-09' ORDER BY machine_number::int;"
