#!/usr/bin/env bash
# Терминал id 92 с серийным номером «264785» — ошибочный дубль, заведённый 22.09.2026 вместо
# переноса настоящего терминала «50264785» (id 59). Номер на iVend восьмизначный и начинается
# с «50»; короткая форма для базы — другая строка, поэтому UNIQUE её пропустил, а сопоставление
# безнала (serial = terminal_external_id) по ней не срабатывает никогда. См. DECISION-084.
#
# За дублем ничего не числится: привязка к аппарату 128 уже снята владельцем, транзакций ноль —
# скрипт это проверяет сам и откатывается, если окажется иначе. Статус меняется на RETIRED:
# ручки в API для списания терминала нет, а с 22.09.2026 GET /api/terminals не показывает
# списанные, поэтому запись уходит из списка и её нельзя случайно привязать к аппарату.
#
# Перед правкой снимается полный дамп базы. Правка идёт одной транзакцией и пишет в audit_log.
#
# Запуск с машины разработки: bash scripts/retire-duplicate-terminal-264785.sh
set -euo pipefail

PROD=root@185.147.82.69
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/root/backup-before-retire-terminal-264785-${STAMP}.dump"

ssh "$PROD" bash -s <<REMOTE
set -euo pipefail
docker exec site2-db sh -c 'pg_dump -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" --format=custom' > "$BACKUP"
echo "Дамп базы: $BACKUP (\$(du -h $BACKUP | cut -f1))"

docker exec -i site2-db sh -c 'psql -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN;

-- Настоящий терминал рядом для наглядности: у него привязки и транзакции должны остаться.
SELECT t.id, t.serial, t.status,
       (SELECT count(*) FROM terminal_bindings b WHERE b.terminal_id = t.id) AS привязок,
       (SELECT count(*) FROM cashless_transactions c WHERE c.terminal_external_id = t.serial) AS транзакций
FROM terminals t WHERE t.serial IN ('264785', '50264785') ORDER BY t.id;

-- Списываем только пустую запись и только если она ровно одна.
WITH old AS (
  SELECT to_jsonb(t) AS d FROM terminals t
  WHERE t.id = 92 AND t.serial = '264785' AND t.status = 'IN_STOCK'
    AND NOT EXISTS (SELECT 1 FROM cashless_transactions c WHERE c.terminal_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM cashless_transactions c WHERE c.terminal_external_id = t.serial)
    AND NOT EXISTS (SELECT 1 FROM terminal_bindings b WHERE b.terminal_id = t.id AND b.ended_at IS NULL)
), upd AS (
  UPDATE terminals t SET status = 'RETIRED'
  FROM old WHERE t.id = (old.d ->> 'id')::bigint
  RETURNING to_jsonb(t) AS d
)
INSERT INTO audit_log (actor_id, actor_login, entity, entity_id, action, old_data, new_data, context)
SELECT NULL, 'system', 'terminal', '92', 'UPDATE', old.d, upd.d,
       jsonb_build_object(
         'reason', 'terminal_retired_duplicate',
         'decision', 'DECISION-084',
         'note', 'Ошибочный дубль короткой формы номера 50264785 от 22.09.2026: привязок и транзакций нет. Списан по просьбе владельца, ручки в API нет.'
       )
FROM old, upd;

DO \$\$
DECLARE retired int;
BEGIN
  SELECT count(*) INTO retired FROM terminals WHERE id = 92 AND status = 'RETIRED';
  IF retired <> 1 THEN
    RAISE EXCEPTION 'Ожидалась ровно одна списанная запись, получено %. Откат.', retired;
  END IF;
END
\$\$;

SELECT t.id, t.serial, t.status FROM terminals t WHERE t.serial IN ('264785', '50264785') ORDER BY t.id;

COMMIT;
SQL
REMOTE

echo
echo "Готово. Дубль списан, в списке терминалов его больше нет."
