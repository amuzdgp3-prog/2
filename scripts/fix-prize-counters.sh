#!/usr/bin/env bash
# Исправление счётчика призов там, где он заведомо неверен (DECISION-057, пункт 4).
#
# Два сентябрьских обслуживания техника Фёдора: на фото счётчика шестизначное показание
# «001468» и «001637», а в систему введено 14681 и 16371 — в обоих случаях приписана лишняя
# цифра. Фотографии проверены глазами, показания счётчика игр на тех же фото совпадают с
# введёнными, так что ошибка только в призах.
#
# На выручку правка не влияет: выручка считается по счётчику игр. Меняются new_prizes и
# статистика расхода игрушек. Старые значения сохраняются в audit_log.
#
# Запуск из корня репозитория: bash scripts/fix-prize-counters.sh
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
API() { curl -sk --resolve 2.apixspb.ru:443:127.0.0.1 "$@"; }

TOKEN=$(API -X POST https://2.apixspb.ru/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

echo "=== как было ==="
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT id, machine_number AS аппарат, occurred_at::date AS дата,
       game_counter AS игры, prize_counter AS призы, new_prizes AS новых_призов, revenue AS выручка
FROM services WHERE id IN (2868, 2889) ORDER BY id;"

# обслуживание:верный счётчик призов по фото
for pair in "2868:1468" "2889:1637"; do
  ID=${pair%%:*}
  PRIZE=${pair##*:}
  echo "-> обслуживание $ID: счётчик призов = $PRIZE (прочитано с фото)"
  API -X PATCH "https://2.apixspb.ru/api/services/$ID" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"prizeCounter\":$PRIZE}" -o /dev/null -w "   HTTP %{http_code}\n"
done

echo
echo "=== как стало ==="
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT id, machine_number AS аппарат, occurred_at::date AS дата,
       game_counter AS игры, prize_counter AS призы, new_prizes AS новых_призов, revenue AS выручка
FROM services WHERE id IN (2868, 2889) ORDER BY id;"

echo "=== не осталось ли обслуживаний, где призов больше игр ==="
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT id, machine_number AS аппарат, occurred_at::date AS дата, game_counter AS игры, prize_counter AS призы
FROM services WHERE prize_counter > game_counter ORDER BY occurred_at;"
