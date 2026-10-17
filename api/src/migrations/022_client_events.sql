-- Журнал событий клиента: ошибки и оборванные операции на телефоне техника (DECISION-087).
--
-- Вылет приложения на телефоне сервер не видит вообще: если браузер закрылся до отправки фото, в
-- логах нет ни запроса, ни обрыва. Поэтому клиент сам докладывает, какую операцию начал и не
-- закончил, и какие ошибки поймал, — вместе с версией сборки, типом сети и памятью устройства.
--
-- Хранится в базе, а не в логе контейнера: тот обнуляется при каждой выкладке. Журнал служебный,
-- строки старше 30 дней удаляет сам сервер при очередной записи.

CREATE TABLE client_events (
    id           BIGSERIAL PRIMARY KEY,
    staff_id     BIGINT REFERENCES staff (id),
    occurred_at  TIMESTAMPTZ NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    app_version  TEXT NOT NULL,
    kind         TEXT NOT NULL,
    screen       TEXT,
    detail       JSONB,
    user_agent   TEXT
);

CREATE INDEX client_events_staff_idx ON client_events (staff_id, received_at DESC);
CREATE INDEX client_events_received_idx ON client_events (received_at);
