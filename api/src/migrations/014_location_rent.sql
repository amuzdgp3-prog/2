-- Аренда за точку — эффективно-датированная ставка, платится за адрес, не за конкретный аппарат
-- (замена аппарата на том же месте не требует повторного ввода аренды). Правка ставки не переписывает
-- историю: текущий открытый период закрывается, новый открывается с даты правки — тот же паттерн,
-- что terminal_bindings (004_terminals_cashless.sql), append-only через forbid_delete.

CREATE TABLE location_rent_periods (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_id    BIGINT NOT NULL REFERENCES locations (id),
    monthly_amount NUMERIC(12,2) NOT NULL CHECK (monthly_amount >= 0),
    started_at     TIMESTAMPTZ NOT NULL,
    ended_at       TIMESTAMPTZ,
    created_by     BIGINT REFERENCES staff (id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR ended_at > started_at)
);

CREATE INDEX location_rent_periods_location_idx ON location_rent_periods (location_id);

-- btree_gist уже подключено в 001_core.sql
ALTER TABLE location_rent_periods ADD CONSTRAINT location_rent_periods_no_overlap
    EXCLUDE USING gist (location_id WITH =, tstzrange(started_at, ended_at) WITH &&);

CREATE TRIGGER location_rent_periods_no_delete BEFORE DELETE ON location_rent_periods
    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
