#!/usr/bin/env bash
# Аппарат № 32 (Сестрорецк, Приморское ш 293), установка 126. Начальный счётчик призов установки
# (machine_placements.initial_prize_counter) перенесён со старой установки со значением 8581 —
# с лишней приписанной единицей, настоящий счётчик 858 (подтверждено владельцем). Продолжение
# правки scripts/fix-prize-counter-machine-32.sh, которая исправила только запись обслуживания
# id 3169. Без этой правки застрявший черновик Федора от 15.09 (призы 1187) сверяется с началом
# установки, то есть с 8581, и снова не проходит: PRIZE_COUNTER_WENT_BACK.
#
# Перед правкой делается дамп таблицы machine_placements на сервере прода. Правка выполняется в
# одной транзакции и откатывается, если затронута не ровно одна строка.
#
# Запуск с машины разработки: bash scripts/fix-placement-126-initial-prize-counter.sh
set -euo pipefail

PROD=root@185.147.82.69
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/root/backup-placements-before-fix-126-${STAMP}.dump"

ssh "$PROD" bash -s <<REMOTE
set -euo pipefail
docker exec site2-db sh -c 'pg_dump -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" --format=custom --table=machine_placements' > "$BACKUP"
echo "Дамп machine_placements: $BACKUP (\$(du -h $BACKUP | cut -f1))"

docker exec -i site2-db sh -c 'psql -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN;
SELECT id, machine_number, started_at::date AS started, initial_game_counter, initial_prize_counter
FROM machine_placements WHERE id = 126;

UPDATE machine_placements SET initial_prize_counter = 858
WHERE id = 126 AND machine_number = '32' AND initial_prize_counter = 8581;

DO \$\$
BEGIN
  IF (SELECT initial_prize_counter FROM machine_placements WHERE id = 126) <> 858 THEN
    RAISE EXCEPTION 'Установка 126 не изменена — откат';
  END IF;
END \$\$;

SELECT id, machine_number, started_at::date AS started, initial_game_counter, initial_prize_counter
FROM machine_placements WHERE id = 126;
COMMIT;
SQL
REMOTE
