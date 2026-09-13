import { ApiError, OfflineError, api } from './api';
import {
  cacheMachines,
  cacheToys,
  markRejected,
  readOutbox,
  removeFromOutbox,
  type CachedMachine,
  type QueuedService,
} from './db';

export interface SyncResult {
  sent: number;
  rejected: number;
  remaining: number;
  offline: boolean;
}

/**
 * Sends the offline queue. Every record carries the localId it was created with, so a retry after
 * a lost response is recognised by the server as the same Service instead of a duplicate.
 * A business rejection (400/409) is kept in the queue as REJECTED for the technician to review,
 * while a network failure simply stops the run and leaves the queue intact.
 *
 * Callers (App's online/user effect, ServiceForm's save-while-online path, and the Queue screen)
 * can all trigger a sync around the same moment; without sharing one in-flight run, two calls
 * would both read the same PENDING list and upload the same items twice.
 */
let inFlight: Promise<SyncResult> | null = null;

export function syncOutbox(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  const run = runSync().finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

async function runSync(): Promise<SyncResult> {
  const queue = await readOutbox();
  const pending = queue.filter((item) => item.status === 'PENDING');
  let sent = 0;
  let rejected = 0;

  for (const item of pending) {
    try {
      await uploadOne(item);
      await removeFromOutbox(item.localId);
      // Черновик уехал — если по нему висела жалоба у администратора, снимаем её. Ошибка здесь
      // не должна ронять синхронизацию: обслуживание уже сохранено, это лишь уборка списка.
      await api.delete(`/api/draft-issues/${item.localId}`).catch(() => undefined);
      sent += 1;
    } catch (error) {
      if (error instanceof OfflineError) {
        return { sent, rejected, remaining: pending.length - sent, offline: true };
      }
      if (error instanceof ApiError && error.status === 401) {
        // The session expired mid-run (api.ts already cleared the token and fired
        // auth:expired) — every remaining item would 401 the same way, and it's a session
        // problem, not a business rejection of this item's data. Leave it and the rest of the
        // queue as PENDING so they retry automatically once the technician logs back in.
        return { sent, rejected, remaining: pending.length - sent - rejected, offline: false };
      }
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        await markRejected(item.localId, error.message, error.code);
        // Доклад администратору: техник в поле один на один с отказом, и без этого о проблеме
        // никто не узнает, пока он сам не позвонит (DECISION-048).
        await api
          .post('/api/draft-issues', {
            localId: item.localId,
            machineNumber: item.machineNumber,
            occurredAt: item.occurredAt,
            errorCode: error.code,
            errorMessage: error.message,
          })
          .catch(() => undefined);
        rejected += 1;
        continue;
      }
      return { sent, rejected, remaining: pending.length - sent - rejected, offline: false };
    }
  }

  return { sent, rejected, remaining: 0, offline: false };
}

async function uploadOne(item: QueuedService): Promise<void> {
  const form = new FormData();
  form.append('localId', item.localId);
  form.append('file', item.photo, `${item.localId}.jpg`);
  const uploaded = await api.upload<{ objectKey: string }>('/api/photos', form);

  await api.post('/api/services', {
    localId: item.localId,
    machineNumber: item.machineNumber,
    occurredAt: item.occurredAt,
    gameCounter: item.gameCounter,
    prizeCounter: item.prizeCounter,
    testGames: item.testGames,
    notes: item.notes,
    toys: item.toys,
    photoObjectKey: uploaded.objectKey,
    // Ставится, только когда техник уже увидел предупреждение о скачке счётчика и подтвердил
    // показание вручную в черновиках (DECISION-048).
    ...(item.confirmCounterJump ? { confirmCounterJump: true } : {}),
  });
}

/** Refreshes the offline catalogue: machines with their counters, divisors and prices, plus toys. */
export async function refreshCatalog(): Promise<void> {
  const machines = await api.get<CachedMachine[]>('/api/machines');
  await cacheMachines(machines);
  const toys = await api.get<Array<{ id: number; name: string; unit_cost: string }>>('/api/toys');
  await cacheToys(toys);
}
