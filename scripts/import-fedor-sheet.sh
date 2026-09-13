#!/usr/bin/env bash
# Импорт обслуживаний из Google-таблицы «Шаблон Фёдор» (листы 1–5, 07–11.09.2026).
#
# Источник — таблица владельца, куда техник Фёдор вносит показания по маршруту вместо
# бумажного бланка. Скачана как .xlsx, адреса сверены с активными точками в базе (везде
# точное совпадение нормализованного текста адреса), даты и рост счётчика проверены на
# монотонность и правдоподобие темпа перед тем, как что-либо создавать.
#
# Правило номеров: числовой префикс в ячейке таблицы («91: Малый проспект ВО, 52») — это
# СОБСТВЕННАЯ нумерация владельца по маршрутному листу, она НЕ совпадает с номером аппарата
# в системе в шести случаях (новые точки 89/91/96/98/106/107 из владельческой нумерации —
# это система-номера 118/111/113/114/112/... соответственно). Сопоставление в этом скрипте
# сделано по тексту адреса, а не по префиксу.
#
# Что скрипт делает для каждой из 20 строк ниже: рендерит картинку строки таблицы (уже
# подготовлена заранее, лежит в row_images/), загружает её как фото обслуживания и создаёт
# обслуживание технику Фёдору (technicianId по DECISION-055, так как заводит администратор).
#
# Что скрипт НЕ делает — и почему, см. отчёт в чате:
#   - № 111 за 07.09 (7616) — рост 7596 игр за 1 день с базы 20, физически невозможно
#   - № 113 за 10.09 (3955) — рост 3935 игр за 4 дня с базы 20, тоже нереалистично
#   - № 18 за 10.09 (4531) — меньше уже прочитанного 14531 за 07.09, счётчик не может идти назад
#   - № 19 за 10.09 (20210) — совпадает день-в-день с 07.09, похоже на случайный повтор, не на новый визит
#   - № 15 за 11.09 (372) — владелец попросил не трогать аппарат 15 отдельно
#   - № 9 за 11.09 (20198) — в системе уже есть обслуживание на эту дату с ДРУГИМ показанием (21905,
#     id 2903, совпадает один-в-один с соседним по времени аппаратом 8 — похоже на опечатку при
#     ручном вводе с телефона); таблица и система расходятся, нужна сверка
#   - «Чапаева 15» — такого адреса нет в системе вообще, нужно уточнение
#
# Запуск из корня репозитория: bash scripts/import-fedor-sheet.sh
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
API() { curl -sk --resolve 2.apixspb.ru:443:127.0.0.1 "$@"; }
ROWDIR="$(pwd)/.import-fedor-images"
FEDOR_ID=9

TOKEN=$(API -X POST https://2.apixspb.ru/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# machine|date|game|prize|soft|small|big|test|time_utc
ROWS='
7|2026-09-07|21975|1779|30|0|7|1|06:00:00
9|2026-09-07|19823|1686|18|0|5|1|06:15:00
10|2026-09-07|23899|2049|14|0|7|1|06:30:00
11|2026-09-07|25686|2595|30|0|6|1|06:45:00
13-2|2026-09-07|627|30|0|0|0|1|07:00:00
14|2026-09-07|23040|1759|31|0|3|1|07:15:00
16|2026-09-07|13579|1408|14|0|0|1|07:30:00
17|2026-09-07|15106|1282|14|0|0|1|07:45:00
18|2026-09-07|14531|1448|16|0|6|1|08:00:00
19|2026-09-07|20210|1594|26|0|4|1|08:15:00
67|2026-09-07|9595|26|18|0|2|1|09:00:00
85|2026-09-07|5375|22|10|0|3|1|09:30:00
30|2026-09-08|18225|1955|3|0|2|1|06:00:00
57|2026-09-08|21842|2222|7|0|2|1|06:20:00
58|2026-09-08|7490|21|0|0|3|1|06:40:00
59|2026-09-08|8630|158|0|0|4|1|07:00:00
118|2026-09-08|101|10|0|0|0|1|07:20:00
111|2026-09-08|128|25|10|0|0|1|07:40:00
87|2026-09-09|3688|19|30|3|0|1|06:00:00
20|2026-09-10|14867|1678|30|5|0|1|06:00:00
'

created=0
failed=0
while IFS='|' read -r m date game prize soft small big test time; do
  [ -z "$m" ] && continue
  LOCAL_ID=$(python3 -c 'import uuid;print(uuid.uuid4())')
  IMG="$ROWDIR/${m}_${date}.png"
  if [ ! -f "$IMG" ]; then
    echo "!! нет картинки строки для $m $date, пропуск"
    failed=$((failed+1))
    continue
  fi

  UPLOAD=$(API -X POST https://2.apixspb.ru/api/photos \
    -H "authorization: Bearer $TOKEN" \
    -F "localId=$LOCAL_ID" -F "file=@$IMG;type=image/png")
  OBJKEY=$(echo "$UPLOAD" | python3 -c 'import sys,json;print(json.load(sys.stdin)["objectKey"])' 2>/dev/null || echo "")
  if [ -z "$OBJKEY" ]; then
    echo "!! аппарат $m $date: загрузка фото не удалась: $UPLOAD"
    failed=$((failed+1))
    continue
  fi

  TOYS="[]"
  python3 -c "
import json
toys=[]
if int('$soft')>0: toys.append({'toyId':1,'quantity':int('$soft')})
if int('$small')>0: toys.append({'toyId':2,'quantity':int('$small')})
if int('$big')>0: toys.append({'toyId':3,'quantity':int('$big')})
print(json.dumps(toys))
" > /tmp/toys_payload.json
  TOYS=$(cat /tmp/toys_payload.json)

  PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'localId': '$LOCAL_ID',
  'machineNumber': '$m',
  'technicianId': $FEDOR_ID,
  'occurredAt': '${date}T${time}Z',
  'gameCounter': int('$game'),
  'prizeCounter': int('$prize'),
  'testGames': int('$test'),
  'toys': $TOYS,
  'photoObjectKey': '$OBJKEY',
  'notes': 'Внесено из таблицы «Шаблон Фёдор» (лист за ${date})',
}, ensure_ascii=False))
")

  RESP=$(API -X POST https://2.apixspb.ru/api/services \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$PAYLOAD")

  if echo "$RESP" | grep -q '"id"'; then
    echo "OK  аппарат $m  $date  счётчик $game"
    created=$((created+1))
  else
    echo "!!  аппарат $m  $date  ОШИБКА: $RESP"
    failed=$((failed+1))
  fi
done <<< "$ROWS"

echo
echo "Создано: $created, ошибок: $failed"
