-- Очередь исходящих сообщений в Telegram (DECISION-092 — какое решение будет записано).
--
-- Прод-сервер в России не может достучаться до api.telegram.org напрямую (заблокировано на уровне
-- провайдера/DPI — см. DECISION-074: TCP:443 до Telegram зависает, ping проходит). Рабочая почта и
-- обычный HTTPS с прода открыты нормально. Поэтому реальную отправку в Telegram делает не сам
-- сервер, а внешний релей на машине, где Telegram уже работает (через VPN): релей раз в несколько
-- минут опрашивает API прода по обычному HTTPS (не блокируется), забирает неотправленные строки
-- отсюда, шлёт их в Telegram и отмечает здесь же результат.
--
-- Два источника сообщений на старте: ежемесячный отчёт владельцу (kind='monthly_report', payload
-- содержит только {year, month} — сам xlsx релей скачивает отдельным запросом в момент отправки,
-- не хранится здесь байтами) и короткие текстовые уведомления (kind='text', payload={text}) — для
-- сбоя бэкапа (backup.sh) и для «черновика на разбор» у администратора (service_reviews).
CREATE TABLE telegram_outbox (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('monthly_report', 'text')),
    payload    JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at    TIMESTAMPTZ,
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

-- Релей всегда выбирает «что ещё не отправлено, по порядку» — один частичный индекс на это.
CREATE INDEX telegram_outbox_pending_idx ON telegram_outbox (id) WHERE sent_at IS NULL;
