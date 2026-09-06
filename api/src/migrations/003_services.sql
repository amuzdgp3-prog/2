-- 003: Service counter chain and toy distribution.
-- Normative sources: 10_ТЗ §7-12 §22, 11_АРХИТЕКТУРА §7-9 §23, 14_BASELINE §6-7, 16_CONTRACT §5-7 §10.

CREATE TYPE service_kind AS ENUM ('REGULAR', 'FINAL');

CREATE TABLE services (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Database-level idempotency authority for offline sync (16_CONTRACT §5, 12_CONTRACT F1).
    local_id                UUID NOT NULL UNIQUE,
    placement_id            BIGINT NOT NULL,
    machine_number          TEXT NOT NULL,
    kind                    service_kind NOT NULL DEFAULT 'REGULAR',
    -- Business date resolved in the Location timezone.
    service_date            DATE NOT NULL,
    occurred_at             TIMESTAMPTZ NOT NULL,
    technician_id           BIGINT REFERENCES staff (id),
    game_counter            BIGINT NOT NULL CHECK (game_counter >= 0),
    prize_counter           BIGINT NOT NULL CHECK (prize_counter >= 0),
    -- Test games are played before the reading and apply to games only (10_ТЗ §7).
    test_games              INTEGER NOT NULL DEFAULT 0 CHECK (test_games >= 0),
    -- Fractional games are preserved without rounding.
    new_games               NUMERIC(14, 4) NOT NULL CHECK (new_games >= 0),
    new_prizes              BIGINT NOT NULL CHECK (new_prizes >= 0),
    price_per_game_snapshot NUMERIC(14, 2) NOT NULL CHECK (price_per_game_snapshot >= 0),
    revenue                 NUMERIC(14, 2) NOT NULL CHECK (revenue >= 0),
    toy_cost                NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (toy_cost >= 0),
    cashless_amount         NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (cashless_amount >= 0),
    -- cash = revenue - cashless; negative cash is preserved, never clamped (10_ТЗ §11 §22.5).
    cash_amount             NUMERIC(14, 2) GENERATED ALWAYS AS (revenue - cashless_amount) STORED,
    is_financial_anomaly    BOOLEAN GENERATED ALWAYS AS (cashless_amount > revenue) STORED,
    -- Counter photo is mandatory (10_ТЗ §21.2, 14_BASELINE §14).
    photo_object_key        TEXT NOT NULL,
    notes                   TEXT NOT NULL DEFAULT '',
    created_by              BIGINT REFERENCES staff (id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Service belongs to exactly one Placement, and the machine must match that Placement.
    CONSTRAINT services_placement_machine_fk FOREIGN KEY (placement_id, machine_number)
        REFERENCES machine_placements (id, machine_number),
    CONSTRAINT services_one_per_placement_date UNIQUE (placement_id, service_date)
);

CREATE INDEX services_chain_idx ON services (placement_id, occurred_at);
CREATE INDEX services_machine_idx ON services (machine_number, occurred_at DESC);
CREATE INDEX services_technician_idx ON services (technician_id, occurred_at DESC);
CREATE INDEX services_anomaly_idx ON services (is_financial_anomaly) WHERE is_financial_anomaly;

CREATE TRIGGER services_touch BEFORE UPDATE ON services
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at ();

-- Regular toy consumption of a Service; priced by server snapshot, never by client input.
CREATE TABLE toy_distributions (
    service_id         BIGINT NOT NULL REFERENCES services (id) ON DELETE CASCADE,
    toy_id             BIGINT NOT NULL REFERENCES toys (id),
    quantity           INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost_snapshot NUMERIC(14, 2) NOT NULL CHECK (unit_cost_snapshot >= 0),
    PRIMARY KEY (service_id, toy_id)
);

-- Counter photos uploaded but not yet permanently associated with a committed Service.
-- Orphans are removed by the cleanup policy (10_ТЗ §21.2).
CREATE TABLE photo_objects (
    object_key   TEXT PRIMARY KEY,
    local_id     UUID NOT NULL,
    uploaded_by  BIGINT REFERENCES staff (id),
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    byte_size    BIGINT NOT NULL,
    content_type TEXT NOT NULL
);
