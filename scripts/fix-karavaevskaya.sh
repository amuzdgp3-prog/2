#!/usr/bin/env bash
# Караваевская 24 (DECISION-056): визит Артёма от 12.09 перенести с ошибочного № 109 на
# настоящий аппарат № 127.
#
# Почему: бумажный журнал подтверждает, что аппарат на Караваевской установлен 11.08 со
# счётчиком 216 и обслужен 20.08 на 268 (владелец подтвердил показание отдельно). Артём 12.09
# обслуживал именно его, но система показывала ему на этом адресе № 109, и показание 1025 легло
# на чужую линию с базой 446. Из-за этого визит посчитан как 569 игр вместо 747 — недосчитано
# 1 780 ₽.
#
# Порядок намеренно такой: сначала создаём запись на верном аппарате, потом удаляем ошибочную.
# Если создание не пройдёт, скрипт остановится и ничего не потеряется. Удалённая строка целиком
# сохраняется в audit_log, откат возможен.
#
# Запуск из корня репозитория: bash scripts/fix-karavaevskaya.sh
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
API() { curl -sk --resolve 2.apixspb.ru:443:127.0.0.1 "$@"; }

TOKEN=$(API -X POST https://2.apixspb.ru/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
AUTH=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

echo "=== как было ==="
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT s.id, s.machine_number, s.occurred_at::date, s.game_counter, s.new_games, s.revenue
FROM services s WHERE s.machine_number IN ('109','127') ORDER BY s.occurred_at;"

# --- шаг 1: та же самая запись на № 127 -------------------------------------------------
# Поля скопированы из services.id = 2920 один в один, кроме local_id — он уникален в таблице.
PAYLOAD=$(python3 - <<'PY'
import json, uuid
print(json.dumps({
  "localId": str(uuid.uuid4()),
  "machineNumber": "127",
  "technicianId": 5,                     # Артём — тот же техник, что в исходной записи
  "occurredAt": "2026-09-12T07:31:00Z",
  "gameCounter": 1025,
  "prizeCounter": 66,
  "testGames": 10,
  "toys": [{"toyId": 1, "quantity": 4}],
  "photoObjectKey": "services/81617050-c98f-49b6-a761-b47f9edcbe6f.jpg",
  "notes": "1) Плохо работает монетник. Снял боковую стенку чтобы он не забивался монетами.\n2) Аппарат периодически уходит в ошибку e4",
}, ensure_ascii=False))
PY
)

echo "-> создаю визит 12.09 на № 127"
RESP=$(API -X POST https://2.apixspb.ru/api/services "${AUTH[@]}" -d "$PAYLOAD")
echo "$RESP"

# Скачок счётчика здесь ожидаем: 268 -> 1025 за 23 дня. Показание сверено с бумажным журналом
# и с записью самого техника, поэтому подтверждаем — это предупреждение, а не запрет.
if echo "$RESP" | grep -q COUNTER_JUMP_SUSPECTED; then
  echo "-> предупреждение о скачке счётчика, показание сверено — подтверждаю"
  RESP=$(API -X POST https://2.apixspb.ru/api/services "${AUTH[@]}" -d "$(
    printf '%s' "$PAYLOAD" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["confirmCounterJump"]=True;print(json.dumps(d,ensure_ascii=False))'
  )")
  echo "$RESP"
fi

if ! printf '%s' "$RESP" | grep -q '"id"'; then
  echo "СОЗДАНИЕ НЕ ПРОШЛО — ошибочная запись не удаляется, останавливаюсь"
  exit 1
fi

# --- шаг 2: удалить ошибочную запись с № 109 --------------------------------------------
echo "-> удаляю ошибочную запись 2920 с № 109 (полная копия остаётся в audit_log)"
API -X DELETE https://2.apixspb.ru/api/services/2920 "${AUTH[@]}"
echo

echo "=== как стало ==="
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT s.id, s.machine_number, s.occurred_at::date, s.game_counter, s.new_games, s.revenue, st.full_name AS техник
FROM services s LEFT JOIN staff st ON st.id = s.technician_id
WHERE s.machine_number IN ('109','127') ORDER BY s.occurred_at;"
docker exec site2-db psql -U apixspb -d apixspb -c "
SELECT p.machine_number, l.name AS точка, p.started_at::date, p.ended_at::date, p.initial_game_counter AS база
FROM machine_placements p JOIN locations l ON l.id = p.location_id
WHERE p.machine_number IN ('109','127') ORDER BY p.machine_number, p.started_at;"
