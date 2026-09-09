-- Business overhead expenses (fuel, salary/advances, card transfers, misc) — a simple, admin-
-- maintained ledger the owner used to track by hand in a separate spreadsheet and paste into the
-- monthly report by hand every month. Not part of the immutable counter-chain financial history
-- (services/cashless_transactions/etc.), so unlike those tables this one carries no forbid_delete
-- trigger: a typo in a hand-entered amount is just fixed or removed, not "retired".

CREATE TYPE expense_category AS ENUM ('FUEL', 'SALARY', 'CARD', 'OTHER');

CREATE TABLE business_expenses (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category     expense_category NOT NULL,
    expense_date DATE NOT NULL,
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    comment      TEXT NOT NULL DEFAULT '',
    created_by   BIGINT REFERENCES staff (id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX business_expenses_date_idx ON business_expenses (expense_date);

CREATE TRIGGER business_expenses_touch BEFORE UPDATE ON business_expenses
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
