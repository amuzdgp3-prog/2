-- A Location captures broad territory (for technician scope grants — 10_ТЗ §16); it does not
-- capture the machine's actual street address, and no other field did either (machine.model has
-- stayed empty on every real machine). The owner has ~110 machines identified day to day by
-- street address, not by which broad territory they're in, and had no way to see or search that
-- address anywhere in the app. Address is placement-scoped, not machine-scoped, for the same
-- reason location_id is: it belongs to wherever the machine currently stands, and must not be
-- silently rewritten for history if the machine later moves (moveMachine, replaceMachine).
ALTER TABLE machine_placements ADD COLUMN address text;
