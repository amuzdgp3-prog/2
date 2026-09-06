-- 004: Terminal binding history, cashless transactions, parser operational state.
-- Normative sources: 10_ТЗ §6 §13-14 §24, 11_АРХИТЕКТУРА §6 §10-13, 14_BASELINE §8-9, 16_CONTRACT §8-9 §16.

CREATE TYPE terminal_status AS ENUM ('IN_STOCK', 'INSTALLED', 'RETIRED');
CREATE TYPE cashless_match_status AS ENUM ('MATCHED', 'UNMATCHED');

CREATE TABLE terminals (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    serial      TEXT NOT NULL UNIQUE,
    provider    TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    status      terminal_status NOT NULL DEFAULT 'IN_STOCK',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER terminals_touch BEFORE UPDATE ON terminals
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at ();

-- Interval history of Terminal → Machine binding. A terminal may sit in stock unbound.
CREATE TABLE terminal_bindings (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    terminal_id    BIGINT NOT NULL REFERENCES terminals (id),
    machine_number TEXT NOT NULL REFERENCES machines (machine_number),
    location_id    BIGINT NOT NULL REFERENCES locations (id),
    started_at     TIMESTAMPTZ NOT NULL,
    ended_at       TIMESTAMPTZ,
    created_by     BIGINT REFERENCES staff (id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT terminal_bindings_period_valid CHECK (ended_at IS NULL OR ended_at > started_at),
    -- One Terminal cannot have overlapping bindings (14_BASELINE §9.1).
    CONSTRAINT terminal_bindings_no_overlap EXCLUDE USING gist (
        terminal_id WITH =,
        tstzrange (started_at, ended_at) WITH &&
    )
);

-- At most one active Terminal per Machine (14_BASELINE §9.2).
CREATE UNIQUE INDEX terminal_bindings_one_active_per_machine
    ON terminal_bindings (machine_number) WHERE ended_at IS NULL;

CREATE INDEX terminal_bindings_lookup_idx
    ON terminal_bindings (terminal_id, started_at DESC);

CREATE TRIGGER terminal_bindings_no_delete BEFORE DELETE ON terminal_bindings
    FOR EACH ROW EXECUTE FUNCTION forbid_delete ();

CREATE TABLE cashless_transactions (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider                TEXT NOT NULL,
    -- Identity: provider id when present, otherwise deterministic fingerprint (10_ТЗ §21.4).
    provider_transaction_id TEXT,
    transaction_fingerprint TEXT,
    terminal_external_id    TEXT NOT NULL,
    terminal_id             BIGINT REFERENCES terminals (id),
    occurred_at             TIMESTAMPTZ NOT NULL,
    amount                  NUMERIC(14, 2) NOT NULL,
    -- Unknown payment types are preserved, never silently converted (10_ТЗ §13).
    payment_type            TEXT NOT NULL,
    raw_payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    match_status            cashless_match_status NOT NULL DEFAULT 'UNMATCHED',
    matched_machine_number  TEXT REFERENCES machines (machine_number),
    matched_placement_id    BIGINT REFERENCES machine_placements (id),
    matched_location_id     BIGINT REFERENCES locations (id),
    unmatched_reason        TEXT,
    imported_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    matched_at              TIMESTAMPTZ,
    CONSTRAINT cashless_identity_present CHECK (
        provider_transaction_id IS NOT NULL OR transaction_fingerprint IS NOT NULL
    )
);

CREATE UNIQUE INDEX cashless_provider_id_identity
    ON cashless_transactions (provider, provider_transaction_id)
    WHERE provider_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX cashless_fingerprint_identity
    ON cashless_transactions (provider, transaction_fingerprint)
    WHERE provider_transaction_id IS NULL;

CREATE INDEX cashless_period_idx ON cashless_transactions (matched_machine_number, occurred_at);
CREATE INDEX cashless_terminal_idx ON cashless_transactions (terminal_id, occurred_at);
CREATE INDEX cashless_unmatched_idx ON cashless_transactions (match_status, occurred_at)
    WHERE match_status = 'UNMATCHED';

-- Unmatched transactions are never deleted; they stay for later rematching (10_ТЗ §13).
CREATE TRIGGER cashless_no_delete BEFORE DELETE ON cashless_transactions
    FOR EACH ROW EXECUTE FUNCTION forbid_delete ();

-- Operational parser settings and schedule. Secrets live in runtime env, never here.
CREATE TABLE parser_settings (
    provider           TEXT PRIMARY KEY,
    is_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    schedule_cron      TEXT NOT NULL DEFAULT '*/15 * * * *',
    overlap_minutes    INTEGER NOT NULL DEFAULT 120 CHECK (overlap_minutes >= 0),
    page_size          INTEGER NOT NULL DEFAULT 200 CHECK (page_size > 0),
    max_pages_per_run  INTEGER NOT NULL DEFAULT 500 CHECK (max_pages_per_run > 0),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE parser_runs (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider           TEXT NOT NULL,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at        TIMESTAMPTZ,
    window_from        TIMESTAMPTZ,
    pages_fetched      INTEGER NOT NULL DEFAULT 0,
    rows_received      INTEGER NOT NULL DEFAULT 0,
    rows_inserted      INTEGER NOT NULL DEFAULT 0,
    rows_duplicate     INTEGER NOT NULL DEFAULT 0,
    rows_matched       INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'RUNNING',
    error_message      TEXT
);
