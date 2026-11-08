-- One-time production correction requested 2026-11-08 for machine 51,
-- Pulkovo highway 107. Only services dated 2026-11-01 onward are repriced.
-- Run with psql -X -v ON_ERROR_STOP=1. All guards and writes share one transaction.
BEGIN;
SELECT pg_advisory_xact_lock(1, hashtext('51'));

DO $fix$
DECLARE
  before_machine machines%ROWTYPE;
  after_machine machines%ROWTYPE;
  before_service services%ROWTYPE;
  after_service services%ROWTYPE;
  affected_count integer;
  basis numeric;
BEGIN
  SELECT * INTO STRICT before_machine FROM machines
  WHERE machine_number = '51' FOR UPDATE;
  IF before_machine.price_per_game <> 10 THEN
    RAISE EXCEPTION 'Machine 51 price changed since preflight: %', before_machine.price_per_game;
  END IF;

  SELECT count(*) INTO affected_count FROM services
  WHERE machine_number = '51' AND service_date >= DATE '2026-11-01';
  IF affected_count <> 1 THEN
    RAISE EXCEPTION 'Expected one service since November 1, found %', affected_count;
  END IF;

  SELECT * INTO STRICT before_service FROM services
  WHERE id = 4473 AND machine_number = '51' AND service_date = DATE '2026-11-07'
  FOR UPDATE;
  IF before_service.price_per_game_snapshot <> 10
     OR before_service.new_games <> 1003
     OR before_service.revenue <> 10030
     OR before_service.cashless_amount <> 8000 THEN
    RAISE EXCEPTION 'Service 4473 changed since preflight';
  END IF;

  SELECT s.toy_cost INTO basis FROM services s
  WHERE s.placement_id = before_service.placement_id
    AND (s.occurred_at, s.id) < (before_service.occurred_at, before_service.id)
  ORDER BY s.occurred_at DESC, s.id DESC LIMIT 1;
  IF NOT FOUND THEN
    SELECT sum(pit.quantity * pit.unit_cost_snapshot) INTO basis
    FROM placement_initial_toys pit
    WHERE pit.placement_id = before_service.placement_id;
  END IF;
  IF basis <> 1290 THEN
    RAISE EXCEPTION 'Service 4473 cost basis changed: %', basis;
  END IF;

  UPDATE machines SET price_per_game = 20 WHERE machine_number = '51'
  RETURNING * INTO after_machine;
  INSERT INTO audit_log (actor_login, entity, entity_id, action, old_data, new_data, context)
  VALUES ('maintenance', 'machine', '51', 'UPDATE', to_jsonb(before_machine),
          to_jsonb(after_machine), '{"reason":"owner-requested price correction 2026-11-08"}'::jsonb);

  UPDATE services
  SET price_per_game_snapshot = 20,
      revenue = round(new_games * 20, 2),
      revenue_to_cost_ratio = round(round(new_games * 20, 2) / basis, 4)
  WHERE id = 4473
  RETURNING * INTO after_service;
  INSERT INTO audit_log (actor_login, entity, entity_id, action, old_data, new_data, context)
  VALUES ('maintenance', 'service', '4473', 'UPDATE', to_jsonb(before_service),
          to_jsonb(after_service), '{"reason":"owner-requested repricing from 2026-11-01"}'::jsonb);

  RAISE NOTICE 'machine 51: price % -> %, service 4473: revenue % -> %, ROI % -> %',
    before_machine.price_per_game, after_machine.price_per_game,
    before_service.revenue, after_service.revenue,
    before_service.revenue_to_cost_ratio, after_service.revenue_to_cost_ratio;
END;
$fix$;

SELECT m.machine_number, m.price_per_game, s.id, s.service_date,
       s.price_per_game_snapshot, s.new_games, s.revenue,
       s.cashless_amount, s.cash_amount, s.is_financial_anomaly,
       s.revenue_to_cost_ratio
FROM machines m JOIN services s ON s.machine_number = m.machine_number
WHERE m.machine_number = '51' AND s.service_date >= DATE '2026-11-01';
COMMIT;
