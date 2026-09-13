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
  /**
   * Подтверждение подозрительного скачка счётчика (DECISION-048). Ставится только вручную, когда
   * техник перепроверил показание и настаивает на нём; тогда сервер перестаёт возражать.
   */
  confirmCounterJump?: boolean;
  /** Код ошибки сервера — по нему черновик показывает подходящее действие, а не общий текст. */
  errorCode?: string;
}

interface MonitorSchema extends DBSchema {
  machines: { key: string; value: CachedMachine };
  outbox: { key: string; value: QueuedService };
  toys: { key: number; value: { id: number; name: string; unit_cost: string } };
  meta: { key: string; value: unknown };
  tasks: { key: number; value: CachedTask };
  taskOutbox: { key: number; value: QueuedTaskClose };
}

/** Задача, скачанная для работы офлайн (DECISION-050). */
export interface CachedTask {
  id: number;
  title: string;
  details: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  machine_number: string | null;
  machine_address: string | null;
  location_name: string | null;
  assigned_to: number | null;
  assigned_name: string | null;
  due_date: string | null;
}

/**
 * Закрытие задачи, сделанное офлайн. Ключ — id самой задачи, а не случайный: техник может нажать
 * «выполнено» дважды, и очередь не должна превращать это в две отправки. Сервер тоже идемпотентен,
 * но полагаться только на него значило бы гонять лишние запросы с телефона в поле.
 */
export interface QueuedTaskClose {
  taskId: number;
  note: string;
  closedAt: string;
}

let database: Promise<IDBPDatabase<MonitorSchema>> | null = null;

function db(): Promise<IDBPDatabase<MonitorSchema>> {
  database ??= openDB<MonitorSchema>('apixspb-monitor', 2, {
    upgrade(instance, oldVersion) {
      // Версия 1 уже стоит на телефонах техников, поэтому новые хранилища добавляются отдельной
      // веткой, а не пересозданием базы: иначе обновление приложения стёрло бы неотправленные
      // черновики вместе с фотографиями счётчиков.
      if (oldVersion < 1) {
        instance.createObjectStore('machines', { keyPath: 'machine_number' });
        instance.createObjectStore('outbox', { keyPath: 'localId' });
        instance.createObjectStore('toys', { keyPath: 'id' });
        instance.createObjectStore('meta');
      }
      if (oldVersion < 2) {
        instance.createObjectStore('tasks', { keyPath: 'id' });
        instance.createObjectStore('taskOutbox', { keyPath: 'taskId' });
      }
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

export async function markRejected(
  localId: string,
  error: string,
  errorCode?: string,
): Promise<void> {
  const instance = await db();
  const item = await instance.get('outbox', localId);
  if (!item) return;
  await instance.put('outbox', { ...item, status: 'REJECTED', error, errorCode });
}

/**
 * Повторная постановка отклонённого черновика в очередь с подтверждением скачка счётчика
 * (DECISION-048): техник перепроверил показание и настаивает на нём.
 */
export async function confirmCounterJumpAndRequeue(localId: string): Promise<void> {
  const instance = await db();
  const item = await instance.get('outbox', localId);
  if (!item) return;
  await instance.put('outbox', {
    ...item,
    status: 'PENDING',
    error: undefined,
    errorCode: undefined,
    confirmCounterJump: true,
  });
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', value, key);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db()).get('meta', key) as Promise<T | undefined>;
}

export async function cacheTasks(tasks: CachedTask[]): Promise<void> {
  const instance = await db();
  const tx = instance.transaction('tasks', 'readwrite');
  await tx.store.clear();
  for (const task of tasks) await tx.store.put(task);
  await tx.done;
}

export async function readTasks(): Promise<CachedTask[]> {
  return (await db()).getAll('tasks');
}

/**
 * Ставит закрытие задачи в очередь и сразу помечает задачу выполненной в локальном кэше, чтобы
 * техник видел результат немедленно, а не после возвращения связи.
 */
export async function queueTaskClose(taskId: number, note: string): Promise<void> {
  const instance = await db();
  await instance.put('taskOutbox', { taskId, note, closedAt: new Date().toISOString() });
  const task = await instance.get('tasks', taskId);
  if (task) await instance.put('tasks', { ...task, status: 'DONE' });
}

export async function readTaskOutbox(): Promise<QueuedTaskClose[]> {
  return (await db()).getAll('taskOutbox');
}

export async function removeTaskClose(taskId: number): Promise<void> {
  await (await db()).delete('taskOutbox', taskId);
}
