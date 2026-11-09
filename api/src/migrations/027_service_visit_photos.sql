-- Two short-lived overview photos per service. The counter photo remains in services.
-- local_id allows both images to arrive before an offline service is committed or reviewed.
CREATE TABLE service_visit_photos (
    local_id    UUID NOT NULL,
    slot        SMALLINT NOT NULL CHECK (slot IN (1, 2)),
    object_key  TEXT NOT NULL UNIQUE REFERENCES photo_objects (object_key) ON DELETE CASCADE,
    uploaded_by BIGINT NOT NULL REFERENCES staff (id),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (local_id, slot)
);

CREATE INDEX service_visit_photos_expiry_idx ON service_visit_photos (uploaded_at);
