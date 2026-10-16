-- Обслуживания техников на проверке у администратора (DECISION-086).
--
-- Раньше отказ сервера по сути записи (счётчик назад, скачок счётчика, аппарат не установлен и т.п.)
-- оставлял черновик в браузере техника, а администратор видел в technician_draft_issues только
-- факт и причину — без показаний и фото. Исправить запись мог только техник, и на практике это
-- превращалось в звонки и объяснения по телефону. Теперь такая запись целиком уезжает сюда, у
-- техника из очереди уходит, а разбирает её администратор: исправляет и сохраняет обслуживание
-- либо отклоняет с комментарием.
--
-- Ключ — local_id черновика, тот же идемпотентный ключ, что у services: повторная отправка того же
-- черновика с телефона узнаётся и не плодит строк. В отличие от technician_draft_issues строки
-- здесь не удаляются после разбора — по ним техник получает итог («администратор исправил…»), и
-- они остаются следом того, кто и что поменял в присланных техником цифрах.

CREATE TYPE service_review_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE service_reviews (
    local_id           UUID PRIMARY KEY,
    technician_id      BIGINT REFERENCES staff (id),
    machine_number     TEXT NOT NULL,
    occurred_at        TIMESTAMPTZ NOT NULL,
    -- Присланный ServiceInput целиком, как его отправил телефон.
    payload            JSONB NOT NULL,
    photo_object_key   TEXT NOT NULL,
    -- Причина, по которой сервер не принял запись; при повторной отправке обновляется.
    error_code         TEXT NOT NULL,
    error_message      TEXT NOT NULL,
    status             service_review_status NOT NULL DEFAULT 'PENDING',
    service_id         BIGINT REFERENCES services (id),
    resolved_by        BIGINT REFERENCES staff (id),
    resolved_at        TIMESTAMPTZ,
    admin_comment      TEXT,
    -- Что администратор поменял относительно присланного: [{field, from, to}].
    changes            JSONB NOT NULL DEFAULT '[]'::jsonb,
    technician_seen_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((status = 'APPROVED') = (service_id IS NOT NULL)),
    CHECK ((status = 'PENDING') = (resolved_at IS NULL))
);

CREATE INDEX service_reviews_status_idx ON service_reviews (status, created_at);
CREATE INDEX service_reviews_technician_idx ON service_reviews (technician_id, created_at DESC);
