-- Owner-requested installation date: 2026-10-08, beginning of the location's day.
-- Run with psql -X -v ON_ERROR_STOP=1. Refuse any intervening operational activity.
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(2, location_id::integer)
FROM machine_placements WHERE machine_number = '150' AND ended_at IS NULL;
SELECT pg_advisory_xact_lock(1, hashtext('150'));

DO $fix$
DECLARE
  old_row machine_placements%ROWTYPE;
  new_row machine_placements%ROWTYPE;
  zone text;
BEGIN
  IF (SELECT count(*) FROM machine_placements WHERE machine_number = '150') <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one placement for machine 150';
  END IF;
  SELECT * INTO STRICT old_row FROM machine_placements
  WHERE machine_number = '150' AND ended_at IS NULL FOR UPDATE;
  SELECT timezone INTO STRICT zone FROM locations WHERE id = old_row.location_id;
  IF (old_row.started_at AT TIME ZONE zone)::date <> DATE '2026-11-24'
     OR (old_row.created_at AT TIME ZONE zone)::date <> DATE '2026-11-24' THEN
    RAISE EXCEPTION 'Installation timestamp was already edited; repeat preflight';
  END IF;
  IF EXISTS (SELECT 1 FROM services WHERE machine_number = '150')
     OR EXISTS (SELECT 1 FROM cashless_transactions WHERE matched_machine_number = '150')
     OR EXISTS (SELECT 1 FROM terminal_bindings
                WHERE machine_number = '150' AND started_at < old_row.started_at) THEN
    RAISE EXCEPTION 'Machine 150 has operational history; correction requires recalculation review';
  END IF;
  UPDATE machine_placements
  SET started_at = TIMESTAMP '2026-10-08 00:00:00' AT TIME ZONE zone
  WHERE id = old_row.id RETURNING * INTO STRICT new_row;
  INSERT INTO audit_log (actor_login, entity, entity_id, action, old_data, new_data, context)
  VALUES ('maintenance', 'placement', old_row.id::text, 'UPDATE',
          to_jsonb(old_row), to_jsonb(new_row),
          '{"reason":"owner-requested installation date correction 2026-11-24"}'::jsonb);
END;
$fix$;

SELECT p.machine_number, p.started_at AT TIME ZONE l.timezone AS installation_local,
       l.timezone
FROM machine_placements p JOIN locations l ON l.id = p.location_id
WHERE p.machine_number = '150' AND p.ended_at IS NULL;
COMMIT;
