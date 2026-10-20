#!/usr/bin/env bash
#
# Страж для ключа синхронизации (DECISION-089). Устанавливается на ПРОДЕ и вызывается из
# /root/.ssh/authorized_keys через command=. Разрешает единственное: rsync в режиме «отдать»
# для backups/ и data/photos/ внутри /opt/sites/2. Всё остальное, включая .env, отклоняется.
set -u
cmd="${SSH_ORIGINAL_COMMAND:-}"
case "$cmd" in
  *..*|*.env*|*\;*|*\&*|*\|*|*\`*|*\$*) echo "отказано" >&2; exit 1 ;;
esac
if [[ "$cmd" =~ ^rsync\ --server\ --sender\ [^\ ]+\ \.\ (backups|data/photos)/[A-Za-z0-9_./*-]*$ ]]; then
  export SSH_ORIGINAL_COMMAND="$cmd"
  exec /usr/bin/rrsync -ro /opt/sites/2
fi
echo "отказано" >&2
exit 1
