#!/usr/bin/env bash
#
# Односторонняя синхронизация прод → эта машина (DECISION-089): последний ночной дамп базы
# восстанавливается в локальную site2-db, фотографии догружаются. На прод ничего не пишется.
# Ключ ~/.ssh/apixspb_sync на проде ограничен стражем scripts/sync-guard.sh (только чтение).
#
# Локальная копия получает боевые данные, поэтому после восстановления выключается парсер iVend
# (иначе локальный сервер пошёл бы в кабинет iVend с боевыми логином и паролем). Письма и Telegram
# отключаются пустыми RESEND_API_KEY/TELEGRAM_BOT_TOKEN в локальном .env.

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
PROD="${SYNC_PROD_HOST:-root@185.147.82.69}"
KEY="${SYNC_KEY:-$HOME/.ssh/apixspb_sync}"
LOG="$BACKUP_DIR/sync.log"
SSH_CMD="ssh -i $KEY -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20"

mkdir -p "$BACKUP_DIR/from-prod"
log() { echo "$(date -Is) $*" >>"$LOG"; }
fail() { log "ОШИБКА: $1"; echo "ОШИБКА: $1" >&2; exit 1; }

# --- 1. Последний дамп с прода ---------------------------------------------------------------
listing="$(rsync -e "$SSH_CMD" --list-only "$PROD:backups/apixspb-db-*.dump.gz" 2>>"$LOG")" \
  || fail "не удалось получить список дампов с прода"
latest="$(echo "$listing" | awk '{print $NF}' | sort | tail -1)"
[ -n "$latest" ] || fail "на проде нет дампов"
rsync -e "$SSH_CMD" -t "$PROD:backups/$latest" "$BACKUP_DIR/from-prod/" 2>>"$LOG" \
  || fail "не удалось скачать $latest"
DUMP="$BACKUP_DIR/from-prod/$(basename "$latest")"
[ -s "$DUMP" ] || fail "скачанный дамп пустой"
gzip -t "$DUMP" || fail "дамп повреждён (gzip -t)"
log "скачан $latest ($(du -h "$DUMP" | cut -f1))"

# --- 2. Восстановление в локальную базу -------------------------------------------------------
RAW="$BACKUP_DIR/from-prod/restore.dump"
gunzip -c "$DUMP" >"$RAW" || fail "не удалось распаковать дамп"
docker cp "$RAW" site2-db:/tmp/restore.dump || fail "не удалось скопировать дамп в контейнер"
rm -f "$RAW"
# Читаем дамп до остановки API: если он не читается, локальная база остаётся нетронутой.
docker exec site2-db pg_restore -l /tmp/restore.dump >/dev/null || fail "pg_restore не читает дамп"

docker stop site2-api >/dev/null
docker exec site2-db pg_restore -U apixspb -d apixspb --clean --if-exists --no-owner /tmp/restore.dump \
  >>"$LOG" 2>&1 || log "предупреждение: pg_restore вернул ненулевой код (см. выше)"
docker exec site2-db rm -f /tmp/restore.dump

# Никаких внешних обращений с локальной копии.
docker exec site2-db psql -U apixspb -d apixspb -qc "UPDATE parser_settings SET is_enabled = false" \
  || fail "не удалось выключить парсер iVend"
docker start site2-api >/dev/null
log "база восстановлена, парсер iVend выключен локально"

# --- 3. Фотографии (только догрузка, без удаления) ---------------------------------------------
rsync -a -e "$SSH_CMD" "$PROD:data/photos/" "$PROJECT_DIR/data/photos/" 2>>"$LOG" \
  || fail "не удалось догрузить фотографии"
log "фотографии синхронизированы"

# Ротация скачанных дампов.
find "$BACKUP_DIR/from-prod" -name 'apixspb-db-*.dump.gz' -mtime +7 -delete
log "синхронизация завершена"
