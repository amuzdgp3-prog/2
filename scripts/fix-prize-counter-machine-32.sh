#!/usr/bin/env bash
# Аппарат № 32 (Сестрорецк, Приморское ш 293). Счётчик призов в базовой записи id 3169
# (установка 126, 19.09.2026) равен 8581 — это значение с лишней приписанной единицей, настоящий
# счётчик 858 (подтверждено владельцем). Из-за этого новое показание (1171 по бланку) считалось
# откатом назад и не сохранялось: PRIZE_COUNTER_WENT_BACK, а затем и CHECK new_prizes >= 0.
#
# Правится только эта одна запись. Остальные записи установки 33 с застывшим 8581 не трогаем:
# счётчик призов не участвует в расчётах (DECISION-059), лишняя правка данных не нужна.
# new_prizes у записи 3169 остаётся 0 (она первая в установке 126), CHECK не нарушается.
#
# Перед правкой делается дамп таблицы services на сервере прода. Правка выполняется в одной
# транзакции и откатывается, если затронута не ровно одна строка.
#
# Запуск с машины разработки: bash scripts/fix-prize-counter-machine-32.sh
set -euo pipefail

PROD=root@185.147.82.69
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/root/backup-services-before-fix-3169-${STAMP}.dump"

ssh "$PROD" bash -s <<REMOTE
set -euo pipefail
docker exec site2-db sh -c 'pg_dump -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" --format=custom --table=services' > "$BACKUP"
echo "Дамп services: $BACKUP (\$(du -h $BACKUP | cut -f1))"

docker exec -i site2-db sh -c 'psql -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN;
SELECT id, placement_id, occurred_at::date AS d, prize_counter, new_prizes
FROM services WHERE id = 3169;

UPDATE services SET prize_counter = 858
WHERE id = 3169 AND machine_number = '32' AND prize_counter = 8581 AND new_prizes = 0;

DO \$\$
BEGIN
  IF (SELECT prize_counter FROM services WHERE id = 3169) <> 858 THEN
    RAISE EXCEPTION 'Запись 3169 не изменена — откат';
  END IF;
END \$\$;

SELECT id, placement_id, occurred_at::date AS d, prize_counter, new_prizes
FROM services WHERE id = 3169;
COMMIT;
SQL
REMOTE
