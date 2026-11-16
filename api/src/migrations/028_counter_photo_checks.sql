CREATE TABLE counter_photo_checks (
    service_id           BIGINT PRIMARY KEY REFERENCES services (id) ON DELETE CASCADE,
    entered_games        BIGINT NOT NULL CHECK (entered_games >= 0),
    entered_prizes       BIGINT CHECK (entered_prizes >= 0),
    status               TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'MATCH', 'MISMATCH', 'UNREADABLE', 'RESOLVED')),
    detected_games       BIGINT CHECK (detected_games >= 0),
    detected_prizes      BIGINT CHECK (detected_prizes >= 0),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    checked_at           TIMESTAMPTZ,
    resolved_at          TIMESTAMPTZ,
    resolved_by          BIGINT REFERENCES staff (id) ON DELETE SET NULL,
    CONSTRAINT counter_photo_detected_pair CHECK (
      (detected_games IS NULL AND detected_prizes IS NULL)
      OR (detected_games IS NOT NULL AND detected_prizes IS NOT NULL AND detected_games > detected_prizes)
    ),
    CONSTRAINT counter_photo_result_state CHECK (
      (status = 'PENDING') = (checked_at IS NULL)
      AND (status = 'RESOLVED') = (resolved_at IS NOT NULL)
    )
);

CREATE INDEX counter_photo_checks_open_idx ON counter_photo_checks (status, service_id)
    WHERE status IN ('PENDING', 'MISMATCH', 'UNREADABLE');
