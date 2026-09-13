#!/usr/bin/env bash
# Продолжение DECISION-060: владелец сообщил настоящие даты и показания установки для
# аппаратов 111 и 113 (даты установки 06.09/03.09 с базой 20 были артефактом реорганизации
# каталога, а не реальными показаниями — тот же класс проблемы, что и раньше в этой сессии).
#
# Правит placement напрямую SQL (штатного API для правки initial_game_counter/started_at нет —
# тот же класс правки, что раньше делался для аппарата 127, см. audit_log id 166573
# "manual_fix_stale_initial_counter", но без ручной вставки в audit_log: классификатор сессии
# отдельно blocks такие вставки как «Logging/Audit Tampering», и это разумно — записью-источником
# истины здесь служит DECISIONS.md, а не подделанная системная запись аудита). После правки базы
# создаёт настоящие обслуживания через обычный API, чтобы recalcMachineChain пересчитал цепочку
# от исправленной базы. Плюс: правит счётчик обслуживания № 9 за 11.09 (в системе стояло 21905 —
# один-в-один с соседним аппаратом 8, владелец подтвердил верное 20198).
#
# Запуск из корня репозитория: bash scripts/fix-111-113-and-import-fedor.sh
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
API() { curl -sk --resolve 2.apixspb.ru:443:127.0.0.1 "$@"; }
FEDOR_ID=9

echo "=== 1. Правим базу установки 111 и 113 напрямую в БД (SQL, без API — его для этого нет) ==="
docker exec site2-db psql -U apixspb -d apixspb -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

-- Аппарат 111 (Малый проспект ВО, 52): реальная установка 18.08, счётчики 13/10.
-- Закрытая установка 101 — артефакт реорганизации каталога 06.09, без единого обслуживания;
-- сдвигаем её на сутки раньше настоящей установки, чтобы не пересекалась по времени.
UPDATE machine_placements
   SET started_at = '2026-08-17T23:00:00Z', ended_at = '2026-08-18T00:00:00Z'
 WHERE id = 101 AND machine_number = '111';

UPDATE machine_placements
   SET started_at = '2026-08-18T00:00:00Z', initial_game_counter = 13, initial_prize_counter = 10
 WHERE id = 157 AND machine_number = '111' AND ended_at IS NULL;

-- Аппарат 113 (Парголово, Михайловская дор): реальная установка 12.08, счётчики 21/10.
UPDATE machine_placements
   SET started_at = '2026-08-11T23:00:00Z', ended_at = '2026-08-12T00:00:00Z'
 WHERE id = 103 AND machine_number = '113';

UPDATE machine_placements
   SET started_at = '2026-08-12T00:00:00Z', initial_game_counter = 21, initial_prize_counter = 10
 WHERE id = 155 AND machine_number = '113' AND ended_at IS NULL;

COMMIT;
SQL

echo
echo "=== 2. Логин ==="
TOKEN=$(API -X POST https://2.apixspb.ru/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

echo
echo "=== 3. Дозаполняем историю 111 и 113 обслуживаниями из настоящей линии счётчика ==="
ROWDIR="$(pwd)/.import-fedor-images"

post_row() {
  local m="$1" date="$2" time="$3" game="$4" prize="$5" test="$6" toys="$7" note="$8" imgkey="$9"
  local local_id; local_id=$(python3 -c 'import uuid;print(uuid.uuid4())')
  local img="$ROWDIR/${imgkey}.png"
  local objkey=""
  if [ -f "$img" ]; then
    local upload; upload=$(API -X POST https://2.apixspb.ru/api/photos -H "authorization: Bearer $TOKEN" \
      -F "localId=$local_id" -F "file=@$img;type=image/png")
    objkey=$(echo "$upload" | python3 -c 'import sys,json;print(json.load(sys.stdin)["objectKey"])' 2>/dev/null || echo "")
  fi
  if [ -z "$objkey" ]; then
    echo "!! нет картинки $imgkey — пропуск $m $date"
    return 1
  fi
  local payload; payload=$(python3 -c "
import json
print(json.dumps({
  'localId': '$local_id', 'machineNumber': '$m', 'technicianId': $FEDOR_ID,
  'occurredAt': '${date}T${time}Z', 'gameCounter': int('$game'), 'prizeCounter': int('$prize'),
  'testGames': int('$test'), 'toys': $toys, 'photoObjectKey': '$objkey', 'notes': '$note',
}, ensure_ascii=False))
")
  local resp; resp=$(API -X POST https://2.apixspb.ru/api/services -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d "$payload")
  if echo "$resp" | grep -q '"id"'; then
    echo "OK  $m  $date  счётчик $game"
  else
    echo "!!  $m  $date  ОШИБКА: $resp"
  fi
}

# 111: 05.09 (промежуточное, игрушки неизвестны — приняты нулевыми, тестовая игра по аналогии
# с остальными строками маршрута) и 08.09 (из таблицы, 10 мягких игрушек)
post_row 111 2026-09-05 06:00:00 17  10 1 '[]' \
  'Показание сообщено владельцем напрямую (не из таблицы Фёдора): установка 18.08 13/10' \
  111_2026-09-05
post_row 111 2026-09-08 07:40:00 128 25 1 '[{"toyId":1,"quantity":10}]' \
  'Внесено из таблицы «Шаблон Фёдор» (лист за 2026-09-08)' \
  111_2026-09-08

# 113: 25.08 и 31.08 промежуточные (игрушки неизвестны), 10.09 из таблицы (139 мягких, 7 малых)
post_row 113 2026-08-25 06:00:00 1306 81  1 '[]' \
  'Показание сообщено владельцем напрямую: установка 12.08 21/10, накопленная история' \
  113_2026-08-25
post_row 113 2026-08-31 06:00:00 2490 142 1 '[]' \
  'Показание сообщено владельцем напрямую: установка 12.08 21/10, накопленная история' \
  113_2026-08-31
post_row 113 2026-09-10 06:00:00 3955 219 1 '[{"toyId":1,"quantity":139},{"toyId":2,"quantity":7}]' \
  'Внесено из таблицы «Шаблон Фёдор» (лист за 2026-09-10)' \
  113_2026-09-10

echo
echo "=== 4. Исправляем показание № 9 за 11.09 (было 21905 — совпадало с соседним аппаратом 8,
     владелец подтвердил верное 20198/1721) ==="
API -X PATCH https://2.apixspb.ru/api/services/2903 \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"gameCounter":20198,"prizeCounter":1721}'
echo

echo
echo "=== Итог: линии счётчиков 111, 113 и обслуживание № 9 ==="
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT machine_number, occurred_at::date, game_counter, prize_counter, new_games, revenue
FROM services WHERE machine_number IN ('111','113','9') ORDER BY machine_number, occurred_at;"
