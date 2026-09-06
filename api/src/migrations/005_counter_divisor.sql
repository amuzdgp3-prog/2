-- 005: per-machine game counter divisor.
--
-- Business rule (DECISION-001, extends the FINAL counter chain of 10_ТЗ §22.2):
-- some machines count several counter units per played game, so the counter growth is divided
-- by a machine-level divisor before test games are subtracted:
--
--     growth            = current_game_counter - previous_game_counter
--     games_from_counter = growth / counter_divisor
--     new_games          = games_from_counter - test_games
--     revenue            = new_games * price_per_game
--
-- counter_divisor defaults to 1.00, which reproduces the previous behaviour exactly.
-- A non-positive divisor is treated as 1 by the service layer and rejected by this CHECK,
-- so a broken value can never silently distort revenue.
--
-- The migration is additive: it adds columns with defaults and never rewrites business values.

ALTER TABLE machines
    ADD COLUMN IF NOT EXISTS counter_divisor NUMERIC(10, 2) NOT NULL DEFAULT 1.00;

ALTER TABLE machines
    DROP CONSTRAINT IF EXISTS machines_counter_divisor_positive;
ALTER TABLE machines
    ADD CONSTRAINT machines_counter_divisor_positive CHECK (counter_divisor > 0);

COMMENT ON COLUMN machines.counter_divisor IS
    'Counter units per one played game. 1.00 = legacy behaviour; growth is divided by it before test games are subtracted.';

-- The divisor actually used by the last recalculation of this Service, kept for transparency.
-- It is refreshed on every recalculation, so changing a machine divisor and recalculating the
-- chain updates history consistently instead of freezing an outdated snapshot.
ALTER TABLE services
    ADD COLUMN IF NOT EXISTS counter_divisor_applied NUMERIC(10, 2) NOT NULL DEFAULT 1.00;

ALTER TABLE services
    DROP CONSTRAINT IF EXISTS services_counter_divisor_positive;
ALTER TABLE services
    ADD CONSTRAINT services_counter_divisor_positive CHECK (counter_divisor_applied > 0);

-- Fractional new_games must survive without rounding. The baseline schema already declares
-- NUMERIC(14,4); this guard converts a legacy integer column in place if the database was
-- migrated from the old integer-based schema. Existing values are preserved by the cast.
DO $$
DECLARE
    current_type TEXT;
BEGIN
    SELECT data_type INTO current_type
    FROM information_schema.columns
    WHERE table_name = 'services' AND column_name = 'new_games';

    IF current_type IS NOT NULL AND current_type <> 'numeric' THEN
        ALTER TABLE services ALTER COLUMN new_games TYPE NUMERIC(14, 4);
    END IF;
END;
$$;
