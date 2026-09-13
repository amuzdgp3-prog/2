-- Застрявшие черновики техников, видимые администратору (DECISION-048).
--
-- Черновик обслуживания живёт в браузере техника (IndexedDB, outbox) и до успешной синхронизации
-- сервер о нём не знает вообще. Пока техник в поле один на один с отказом, администратор не может
-- ни увидеть проблему, ни помочь. Поэтому при отказе синхронизации клиент докладывает сюда факт и
-- причину — не сам черновик с фотографией, а именно проблему: чей, по какому аппарату и почему.
--
-- Ключ — local_id черновика, тот же идемпотентный ключ, что у services. Повторный доклад по тому
-- же черновику обновляет причину, а не плодит строки: техник может исправлять показание несколько
-- раз, и админу нужна последняя причина, а не история попыток.
--
-- Строка удаляется, когда черновик наконец ушёл или техник его удалил: это оперативный список
-- «что сейчас болит», а не журнал. История отказов при необходимости восстанавливается по audit_log
-- и parser_runs, дублировать её здесь незачем.

CREATE TABLE technician_draft_issues (
    local_id       UUID PRIMARY KEY,
    technician_id  BIGINT REFERENCES staff (id),
    machine_number TEXT NOT NULL,
    occurred_at    TIMESTAMPTZ NOT NULL,
    error_code     TEXT NOT NULL,
    error_message  TEXT NOT NULL,
    reported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX technician_draft_issues_tech_idx
    ON technician_draft_issues (technician_id, updated_at DESC);
