CREATE TABLE auth_sessions (
    id           UUID PRIMARY KEY,
    staff_id     BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    refresh_hash TEXT NOT NULL UNIQUE,
    device_label TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX auth_sessions_staff_idx ON auth_sessions(staff_id);
