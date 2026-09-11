#!/usr/bin/env bash
#
# Резервное копирование 2.apixspb.ru.
#
# Схема раздельная, а не одним архивом (DECISION-040): дамп базы маленький и меняется каждый день,
# фотографии счётчиков большие и неизменяемые. Раньше каждую ночь заново упаковывались и
# выгружались все фотографии разом, из-за чего суточный архив дорос до 132 МБ и переполнил диск
# Google. Теперь ежедневно уезжает только дамп (около 7 МБ), а фотографии догружаются по одной, по
# мере появления.
#
# Фотографии выгружаются через `rclone copy`, а не `sync`, намеренно: copy никогда не удаляет файлы
# в облаке. Фотография счётчика — это доказательство показаний, и локальная её пропажа (очистка
# осиротевших файлов, сбой диска, ошибка оператора) не должна распространяться на резервную копию.
#
# Неудача любого шага больше не проходит молча: раньше `set -e` убивал скрипт прямо на падении
# rclone, до строки лога, и о сбое можно было узнать только открыв cron.log вручную.

set -uo pipefail

PROJECT_DIR="/home/s/Work/sites/2"
BACKUP_DIR="$PROJECT_DIR/backups"
KEEP_DAYS=30

# Имя rclone-хранилища вынесено в переменную: аккаунт для резервных копий меняется отдельно от
# самого скрипта. Задать другой можно строкой BACKUP_REMOTE=<имя> в .env (она читается ниже) или
# переменной окружения при ручном запуске. Список настроенных хранилищ — `rclone listremotes`.
REMOTE_NAME="${BACKUP_REMOTE:-$(grep -E '^BACKUP_REMOTE=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2-)}"
REMOTE_NAME="${REMOTE_NAME:-gdrive}"
REMOTE="${REMOTE_NAME}:apixspb-backups"
STAMP="$(date +%Y-%m-%d_%H-%M)"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

log() { echo "$(date -Is) $*" >>"$LOG"; }

# Оповещение владельцу тем же ботом, что шлёт ежемесячный отчёт. Токен читается из .env и никогда
# не попадает ни в лог, ни в вывод команды.
notify() {
  local text="$1"
  local token chat
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PROJECT_DIR/.env" | cut -d= -f2-)"
  chat="$(grep -E '^TELEGRAM_OWNER_CHAT_ID=' "$PROJECT_DIR/.env" | cut -d= -f2-)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  curl -s -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=${text}" || true
}

fail() {
  log "ОШИБКА: $1"
  notify "Бэкап 2.apixspb.ru не прошёл: $1"
  exit 1
}

# --- 1. Дамп базы ---------------------------------------------------------------------------
DUMP="$BACKUP_DIR/apixspb-db-$STAMP.dump.gz"
docker exec site2-db pg_dump -U apixspb -d apixspb --format=custom --file=/tmp/db.dump \
  || fail "pg_dump не отработал"
docker exec site2-db sh -c 'gzip -c /tmp/db.dump' >"$DUMP" || fail "не удалось выгрузить дамп из контейнера"
docker exec site2-db rm -f /tmp/db.dump

[ -s "$DUMP" ] || fail "дамп получился пустым"
log "дамп готов: $DUMP ($(du -h "$DUMP" | cut -f1))"

# --- 2. Локальная ротация -------------------------------------------------------------------
find "$BACKUP_DIR" -name 'apixspb-db-*.dump.gz' -mtime +"$KEEP_DAYS" -delete

# --- 3. Выгрузка в облако -------------------------------------------------------------------
if ! command -v rclone >/dev/null 2>&1 || ! rclone listremotes 2>/dev/null | grep -qx "${REMOTE_NAME}:"; then
  fail "rclone или хранилище «${REMOTE_NAME}» не настроено, копия осталась только локально"
fi

rclone copy "$DUMP" "$REMOTE/db/" --quiet || fail "не удалось выгрузить дамп базы в облако"
log "дамп выгружен в $REMOTE/db/"

# Фотографии: только новые. Удалений не делаем — см. комментарий в шапке.
rclone copy "$PROJECT_DIR/data/photos" "$REMOTE/photos/" --quiet \
  || fail "не удалось догрузить фотографии счётчиков"
log "фотографии синхронизированы"

# Ротация дампов в облаке. Папка photos не трогается никогда.
rclone delete "$REMOTE/db/" --min-age "${KEEP_DAYS}d" --quiet || log "предупреждение: ротация дампов в облаке не отработала"

log "бэкап завершён успешно"
