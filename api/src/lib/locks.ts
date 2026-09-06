import type { Client } from '../db/pool.js';

const MACHINE_LOCK_NAMESPACE = 1;
const LOCATION_LIFECYCLE_LOCK_NAMESPACE = 2;

/**
 * Canonical lock protocol (11_АРХИТЕКТУРА §15): the Machine is the primary lock key and
 * multiple machines are always locked in ascending order of machine number, so Service,
 * recalculation, terminalReplace, matcher and closeLocation can never deadlock against
 * each other. Locks are transaction-scoped and released by COMMIT/ROLLBACK.
 */
export async function lockMachines(client: Client, machineNumbers: string[]): Promise<void> {
  const ordered = [...new Set(machineNumbers)].sort();
  for (const machineNumber of ordered) {
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      MACHINE_LOCK_NAMESPACE,
      machineNumber,
    ]);
  }
}

export async function lockLocationLifecycle(client: Client, locationId: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
    LOCATION_LIFECYCLE_LOCK_NAMESPACE,
    locationId,
  ]);
}
