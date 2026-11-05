-- Owner's bag reconciliation. Expenses remain in the original ledger; a handover is not an expense.
CREATE TABLE cash_collections (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    technician_id BIGINT NOT NULL REFERENCES staff(id),
    period_from DATE NOT NULL CHECK (period_from >= DATE '2026-11-01'),
    period_to DATE NOT NULL CHECK (period_to >= period_from),
    received_on DATE NOT NULL CHECK (received_on >= period_to),
    expected NUMERIC(14,2) NOT NULL CHECK (expected >= 0),
    snapshot JSONB NOT NULL,
    actual NUMERIC(14,2) CHECK (actual >= 0),
    comment TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    counted_at TIMESTAMPTZ,
    UNIQUE (technician_id, period_to)
);
CREATE TRIGGER cash_collections_no_delete BEFORE DELETE ON cash_collections
    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
