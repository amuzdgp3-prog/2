-- 001_core: extensions, lifecycle enums, Location tree, Staff/RBAC, audit, global settings.
-- Normative sources: 10_ТЗ §1-3 §16-17, 11_АРХИТЕКТУРА §1-3 §16-17, 16_DDL_MIGRATION_CONTRACT §1 §14-15 §18.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE location_status AS ENUM ('ACTIVE', 'DEACTIVATED', 'CLOSED');
CREATE TYPE staff_role AS ENUM ('ADMIN', 'TECHNICIAN', 'BOSS');

-- Timezone is validated by trigger: a CHECK cannot call the non-immutable catalog lookup.
CREATE FUNCTION assert_valid_timezone () RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
        RAISE EXCEPTION 'invalid IANA timezone: %', NEW.timezone
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Physical deletion is forbidden for history-bearing tables (10_ТЗ §2 §19, 16_CONTRACT §1-2).
CREATE FUNCTION forbid_delete () RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'physical delete is forbidden for table %', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION touch_updated_at () RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Location = physical point. Owns history and financial aggregation, never deleted.
CREATE TABLE locations (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id        BIGINT REFERENCES locations (id),
    name             TEXT NOT NULL,
    address          TEXT NOT NULL DEFAULT '',
    -- Location.timezone is the single business-time source (10_ТЗ §3).
    timezone         TEXT NOT NULL,
    status           location_status NOT NULL DEFAULT 'ACTIVE',
    min_service_days INTEGER CHECK (min_service_days IS NULL OR min_service_days > 0),
    max_service_days INTEGER CHECK (max_service_days IS NULL OR max_service_days > 0),
    closed_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT locations_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX locations_parent_idx ON locations (parent_id);
CREATE INDEX locations_status_idx ON locations (status);

CREATE TRIGGER locations_timezone_check BEFORE INSERT OR UPDATE OF timezone ON locations
    FOR EACH ROW EXECUTE FUNCTION assert_valid_timezone ();
CREATE TRIGGER locations_touch BEFORE UPDATE ON locations
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at ();
CREATE TRIGGER locations_no_delete BEFORE DELETE ON locations
    FOR EACH ROW EXECUTE FUNCTION forbid_delete ();

CREATE TABLE staff (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    login         TEXT NOT NULL UNIQUE,
    full_name     TEXT NOT NULL,
    role          staff_role NOT NULL,
    password_hash TEXT NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER staff_touch BEFORE UPDATE ON staff
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at ();

-- Technician scope: Location subtrees, resolved server-side on every protected endpoint.
CREATE TABLE staff_location_scope (
    staff_id    BIGINT NOT NULL REFERENCES staff (id),
    location_id BIGINT NOT NULL REFERENCES locations (id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (staff_id, location_id)
);

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global configured default for service-interval inheritance (17_GATE §3).
INSERT INTO app_settings (key, value) VALUES
    ('service_interval_defaults', '{"min_service_days": 3, "max_service_days": 14}'::jsonb),
    ('currency', '"RUB"'::jsonb);

CREATE TABLE audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id    BIGINT REFERENCES staff (id),
    actor_login TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    entity      TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data    JSONB,
    new_data    JSONB,
    context     JSONB
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, occurred_at DESC);
