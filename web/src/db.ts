import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface CachedMachine {
  machine_number: string;
  machine_type: string;
  model: string;
  price_per_game: string;
  counter_divisor: string;
  status: string;
  location_id: number | null;
  location_name: string | null;
  location_status: string | null;
  address: string | null;
  timezone: string | null;
  placement_id: number | null;
  previous_game_counter: number;
  previous_prize_counter: number;
  last_service_at: string | null;
  last_new_games: string | null;
  last_revenue: string | null;
  last_toy_cost: string | null;
  last_revenue_to_cost_ratio: string | null;
  last_toy_quantities: Record<string, number> | null;
  default_toy_set_id: number | null;
  default_toy_set_name: string | null;
  default_toy_set_items: Record<string, number> | null;
  min_service_days: number | null;
  max_service_days: number | null;
  terminal_id: number | null;
  terminal_serial: string | null;
}

export interface QueuedService {
  localId: string;
  machineNumber: string;
  occurredAt: string;
  gameCounter: number;
  prizeCounter: number;
  testGames: number;
  notes: string;
  toys: Array<{ toyId: number; quantity: number }>;
  photo: Blob;
  photoType: string;
  queuedAt: string;
  status: 'PENDING' | 'REJECTED';
  error?: string;
}

interface MonitorSchema extends DBSchema {
  machines: { key: string; value: CachedMachine };
  outbox: { key: string; value: QueuedService };
  toys: { key: number; value: { id: number; name: string; unit_cost: string } };
  meta: { key: string; value: unknown };
}

let database: Promise<IDBPDatabase<MonitorSchema>> | null = null;

function db(): Promise<IDBPDatabase<MonitorSchema>> {
  database ??= openDB<MonitorSchema>('apixspb-monitor', 1, {
    upgrade(instance) {
      instance.createObjectStore('machines', { keyPath: 'machine_number' });
      instance.createObjectStore('outbox', { keyPath: 'localId' });
      instance.createObjectStore('toys', { keyPath: 'id' });
      instance.createObjectStore('meta');
    },
  });
  return database;
}

export async function cacheMachines(machines: CachedMachine[]): Promise<void> {
  const instance = await db();
  const tx = instance.transaction('machines', 'readwrite');
  await tx.store.clear();
  await Promise.all(machines.map((machine) => tx.store.put(machine)));
  await tx.done;
  await setMeta('machines_synced_at', new Date().toISOString());
}

export async function readCachedMachines(): Promise<CachedMachine[]> {
  return (await db()).getAll('machines');
}

export async function cacheToys(toys: Array<{ id: number; name: string; unit_cost: string }>): Promise<void> {
  const instance = await db();
  const tx = instance.transaction('toys', 'readwrite');
  await tx.store.clear();
  await Promise.all(toys.map((toy) => tx.store.put(toy)));
  await tx.done;
}

export async function readCachedToys() {
  return (await db()).getAll('toys');
}

export async function enqueueService(service: QueuedService): Promise<void> {
  await (await db()).put('outbox', service);
}

/** Used to prefill the form when a technician edits a draft that hasn't synced yet. */
export async function getQueuedByLocalId(localId: string): Promise<QueuedService | undefined> {
  return (await db()).get('outbox', localId);
}

export async function readOutbox(): Promise<QueuedService[]> {
  const items = await (await db()).getAll('outbox');
  return items.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
}

export async function removeFromOutbox(localId: string): Promise<void> {
  await (await db()).delete('outbox', localId);
}

export async function markRejected(localId: string, error: string): Promise<void> {
  const instance = await db();
  const item = await instance.get('outbox', localId);
  if (!item) return;
  await instance.put('outbox', { ...item, status: 'REJECTED', error });
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', value, key);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db()).get('meta', key) as Promise<T | undefined>;
}
