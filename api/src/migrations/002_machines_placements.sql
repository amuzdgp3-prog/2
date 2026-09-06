-- 002: Machine (physical consumable object), Placement history, toys, routes, technician assignments.
-- Normative sources: 10_ТЗ §1 §4-5 §8 §21, 11_АРХИТЕКТУРА §2 §4-5 §8, 14_BASELINE §3-5, 16_CONTRACT §2-4 §7.

CREATE TYPE machine_status AS ENUM ('ACTIVE', 'RETIRED');

-- A machine number is issued once and is never reused, even if the machine row disappears.
CREATE TABLE machine_numbers (
    machine_number TEXT PRIMARY KEY,
    issued_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER machine_numbers_no_delete BEFORE DELETE ON machine_numbers
    FOR EACH ROW EXECUTE FUNCTION forbid_delete ();

CREATE TABLE machines (
    machine_number   TEXT PRIMARY KEY REFERENCES machine_numbers (machine_number),
    machine_type     TEXT NOT NULL DEFAULT 'CRANE',
    model            TEXT NOT NULL DEFAULT '',
    -- Server-side price is the only source of truth for revenue (10_ТЗ §8-9).
    price_per_game   NUMERIC(14, 2) NOT NULL CHECK (price_per_game >= 0),
    status           machine_status NOT NULL DEFAULT 'ACTIVE',
    min_service_days INTEGER CHECK (min_service_days IS NULL OR min_service_days > 0),
    max_service_days INTEGER CHECK (max_service_days IS NULL OR max_service_days > 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER machines_touch BEFORE UPDATE ON machines
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at ();
CREATE TRIGGER machines_no_delete BEFORE DELETE ON machines
    FOR EACH ROW EXECUTE FUNCTION forbid_delete ();

CREATE FUNCTION register_machine_number () RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO machine_numbers (machine_number) VALUES (NEW.machine_number)
        ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machines_register_number BEFORE INSERT ON machines
    FOR EACH ROW EXECUTE FUNCTION register_machine_number ();

-- Placement = historical period of one Machine on one Location. Machines never move between
-- Locations: a physical move is a new Machine with a new Placement (10_ТЗ §5).
CREATE TABLE machine_placements (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_number        TEXT NOT NULL REFERENCES machines (machine_number),
    location_id           BIGINT NOT NULL REFERENCES locations (id),
    started_at            TIMESTAMPTZ NOT NULL,
    ended_at              TIMESTAMPTZ,
    initial_game_counter  BIGINT NOT NULL CHECK (initial_game_counter >= 0),
    initial_prize_counter BIGINT NOT NULL CHECK (initial_prize_counter >= 0),
    installed_by          BIGINT REFERENCES staff (id),
    closed_by             BIGINT REFERENCES staff (id),
    close_reason          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT placements_period_valid CHECK (ended_at IS NULL OR ended_at > started_at),
    -- Composite target for the Service integrity FK (16_CONTRACT §5).
    CONSTRAINT placements_id_machine_unique UNIQUE (id, machine_number),
    -- At most one active Placement per Machine, and no overlapping placements at all.
    CONSTRAINT placements_no_overlap EXCLUDE USING gist (
        machine_number WITH =,
        tstzrange (started_at, ended_at) WITH &&
    )
);

CREATE INDEX placements_machine_idx ON machine_placements (machine_number, started_at DESC);
CREATE INDEX placements_location_idx ON machine_placements (location_id);
CREATE INDEX placements_active_idx ON machine_placements (machine_number) WHERE ended_at IS NULL;

CREATE TRIGGER placements_no_delete BEFORE DELETE ON machine_placements
    FOR EACH ROW EXECUTE FUNCTION forbid_delete ();

CREATE TABLE toys (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    unit_cost  NUMERIC(14, 2) NOT NULL CHECK (unit_cost >= 0),
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER toys_touch BEFORE UPDATE ON toys
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at ();

-- Installation toys are Placement state, not the cost of the first Service (10_ТЗ §4 §8).
CREATE TABLE placement_initial_toys (
    placement_id       BIGINT NOT NULL REFERENCES machine_placements (id),
    toy_id             BIGINT NOT NULL REFERENCES toys (id),
    quantity           INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost_snapshot NUMERIC(14, 2) NOT NULL CHECK (unit_cost_snapshot >= 0),
    PRIMARY KEY (placement_id, toy_id)
);

CREATE TABLE routes (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name             TEXT NOT NULL,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    min_service_days INTEGER CHECK (min_service_days IS NULL OR min_service_days > 0),
    max_service_days INTEGER CHECK (max_service_days IS NULL OR max_service_days > 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER routes_touch BEFORE UPDATE ON routes
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at ();

CREATE TABLE machine_routes (
    machine_number TEXT NOT NULL REFERENCES machines (machine_number),
    route_id       BIGINT NOT NULL REFERENCES routes (id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (machine_number, route_id)
);

-- Point technician assignments, in addition to the Location-tree scope.
CREATE TABLE machine_technicians (
    machine_number TEXT NOT NULL REFERENCES machines (machine_number),
    staff_id       BIGINT NOT NULL REFERENCES staff (id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (machine_number, staff_id)
);
