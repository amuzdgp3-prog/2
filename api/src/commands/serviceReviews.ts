import { withTransaction, type Client } from '../db/pool.js';
import { auditDelete, auditUpdate, type Actor } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';
import { clearDraftIssue } from './draftIssues.js';
import { createService, type ServiceInput, type ToyLine } from './services.js';

/**
 * Обслуживания техников на проверке у администратора (DECISION-086, 021_service_reviews.sql).
 *
 * Отказ сервера по сути записи раньше возвращался технику, и исправлять показания приходилось ему —
 * обычно по телефону под диктовку администратора. Теперь такая запись целиком сохраняется здесь, у
 * техника из очереди уходит, а разбирает её администратор: исправляет и сохраняет обслуживание
 * либо отклоняет с комментарием. Техник видит итог у себя в приложении.
 */

/**
 * Отказы, которые означают «с данными что-то не так» и которые администратор может разобрать сам:
 * поправить цифру, дату или установку аппарата. Остальные отказы (нет фото, чужой localId, ошибка
 * формата) передавать некому — в них нечего исправлять, и они возвращаются как раньше.
 */
const REVIEWABLE_CODES = new Set([
  'GAME_COUNTER_WENT_BACK',
  'PRIZE_COUNTER_WENT_BACK',
  'TEST_GAMES_EXCEED_GROWTH',
  'COUNTER_JUMP_SUSPECTED',
  'NO_ACTIVE_PLACEMENT',
  'LOCATION_NOT_ACTIVE',
  'BEFORE_PLACEMENT_START',
  'AFTER_PLACEMENT_END',
  'FUTURE_OCCURRED_AT',
  'UNKNOWN_MACHINE',
  'SERVICE_INTERVAL_UNRESOLVED',
]);

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReviewChange {
  field: string;
  from: unknown;
  to: unknown;
}

interface ReviewRow {
  local_id: string;
  technician_id: number | null;
  machine_number: string;
  occurred_at: Date;
  payload: ServiceInput;
  photo_object_key: string;
  error_code: string;
  error_message: string;
  status: ReviewStatus;
  service_id: number | null;
  resolved_by: number | null;
  resolved_at: Date | null;
  admin_comment: string | null;
  changes: ReviewChange[];
  technician_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Ответ телефону: запись не сохранена как обслуживание, а лежит (или уже разобрана) на проверке. */
export interface InReviewResult {
  status: ReviewStatus;
  errorCode: string;
  message: string;
  serviceId: number | null;
}

const toResult = (row: ReviewRow): InReviewResult => ({
  status: row.status,
  errorCode: row.error_code,
  message: row.error_message,
  serviceId: row.service_id == null ? null : Number(row.service_id),
});

async function loadReview(client: Client, localId: string, lock = false): Promise<ReviewRow | null> {
  const result = await client.query<ReviewRow>(
    `SELECT * FROM service_reviews WHERE local_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [localId],
  );
  return result.rows[0] ?? null;
}

/**
 * Отправка обслуживания техником.
 *
 * Флаги подтверждения скачка счётчика и отката призов от техника не принимаются: такие показания
 * подтверждает только администратор. Повторная отправка черновика, который уже на проверке,
 * узнаётся по localId и отвечает текущим состоянием проверки — даже если администратор успел
 * поменять цифры, телефону это не конфликт, а повод убрать черновик из очереди.
 *
 * Возвращает либо обслуживание (как createService), либо состояние проверки.
 */
export async function submitTechnicianService(
  actor: Actor,
  input: ServiceInput,
): Promise<
  | { kind: 'stored'; stored: Awaited<ReturnType<typeof createService>> }
  | { kind: 'review'; review: InReviewResult }
> {
  const { existing, alreadyStored } = await withTransaction(async (client) => ({
    existing: await loadReview(client, input.localId),
    alreadyStored: Boolean(
      (await client.query('SELECT 1 FROM services WHERE local_id = $1', [input.localId])).rowCount,
    ),
  }));
  if (existing) {
    if (Number(existing.technician_id) !== Number(actor.id)) {
      throw conflict('LOCAL_ID_CONFLICT', 'обслуживание с таким идентификатором уже сохранено с другими данными');
    }
    return { kind: 'review', review: toResult(existing) };
  }
  // Повтор после потерянного ответа по уже сохранённому обслуживанию (в том числе подтверждённому
  // старой версией приложения) — обычный идемпотентный путь createService, без снятия флагов:
  // иначе повтор споткнулся бы о проверку, которую исходная отправка уже прошла.
  if (alreadyStored) {
    const stored = await withTransaction((client) => createService(client, actor, input));
    return { kind: 'stored', stored };
  }

  const { confirmCounterJump: _jump, confirmPrizeCounterBack: _prize, ...clean } = input;
  try {
    const stored = await withTransaction((client) => createService(client, actor, clean));
    return { kind: 'stored', stored };
  } catch (error) {
    if (!(error instanceof AppError) || !REVIEWABLE_CODES.has(error.code)) throw error;
    const review = await withTransaction((client) => putOnReview(client, actor, clean, error));
    return { kind: 'review', review: toResult(review) };
  }
}

async function putOnReview(
  client: Client,
  actor: Actor,
  input: ServiceInput,
  error: AppError,
): Promise<ReviewRow> {
  const result = await client.query<ReviewRow>(
    `INSERT INTO service_reviews
       (local_id, technician_id, machine_number, occurred_at, payload, photo_object_key,
        error_code, error_message)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8)
     ON CONFLICT (local_id) DO UPDATE SET updated_at = service_reviews.updated_at
     RETURNING *`,
    [
      input.localId,
      actor.id,
      input.machineNumber,
      input.occurredAt,
      JSON.stringify(input),
      input.photoObjectKey,
      error.code,
      error.message.slice(0, 1000),
    ],
  );
  // Запись теперь у администратора целиком — старая жалоба «у техника не уходит» больше не нужна.
  await clearDraftIssue(client, input.localId);
  return result.rows[0];
}

export interface ReviewListItem {
  localId: string;
  technicianId: number | null;
  technicianName: string | null;
  machineNumber: string;
  machineAddress: string | null;
  occurredAt: Date;
  errorCode: string;
  errorMessage: string;
  status: ReviewStatus;
  serviceId: number | null;
  resolvedByName: string | null;
  resolvedAt: Date | null;
  adminComment: string | null;
  changes: ReviewChange[];
  createdAt: Date;
}

export interface ReviewDetail extends ReviewListItem {
  payload: ServiceInput;
  photoObjectKey: string;
}

const SELECT_WITH_NAMES = `
  SELECT r.*, t.full_name AS technician_name, a.full_name AS resolved_by_name,
         p.address AS machine_address
  FROM service_reviews r
  LEFT JOIN staff t ON t.id = r.technician_id
  LEFT JOIN staff a ON a.id = r.resolved_by
  LEFT JOIN machine_placements p ON p.machine_number = r.machine_number AND p.ended_at IS NULL`;

type NamedRow = ReviewRow & {
  technician_name: string | null;
  resolved_by_name: string | null;
  machine_address: string | null;
};

const toListItem = (row: NamedRow): ReviewListItem => ({
  localId: row.local_id,
  technicianId: row.technician_id == null ? null : Number(row.technician_id),
  technicianName: row.technician_name,
  machineNumber: row.machine_number,
  machineAddress: row.machine_address,
  occurredAt: row.occurred_at,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  status: row.status,
  serviceId: row.service_id == null ? null : Number(row.service_id),
  resolvedByName: row.resolved_by_name,
  resolvedAt: row.resolved_at,
  adminComment: row.admin_comment,
  changes: row.changes,
  createdAt: row.created_at,
});

const toDetail = (row: NamedRow): ReviewDetail => ({
  ...toListItem(row),
  payload: row.payload,
  photoObjectKey: row.photo_object_key,
});

const STATUSES = new Set<ReviewStatus>(['PENDING', 'APPROVED', 'REJECTED']);

export async function listReviews(
  client: Client,
  actor: Actor,
  status: string | undefined,
): Promise<ReviewListItem[]> {
  assertAdmin(actor);
  const filter = status && STATUSES.has(status as ReviewStatus) ? status : 'PENDING';
  const result = await client.query<NamedRow>(
    `${SELECT_WITH_NAMES}
     WHERE r.status = $1
     ORDER BY ${filter === 'PENDING' ? 'r.created_at ASC' : 'r.resolved_at DESC'}
     LIMIT 200`,
    [filter],
  );
  return result.rows.map(toListItem);
}

export async function getReview(client: Client, actor: Actor, localId: string): Promise<ReviewDetail> {
  assertAdmin(actor);
  const result = await client.query<NamedRow>(`${SELECT_WITH_NAMES} WHERE r.local_id = $1`, [localId]);
  if (!result.rows[0]) throw notFound('запись на проверке не найдена');
  return toDetail(result.rows[0]);
}

/** Что администратор поменял относительно присланного техником — для уведомления технику. */
export function diffReview(sent: ServiceInput, saved: ServiceInput): ReviewChange[] {
  const changes: ReviewChange[] = [];
  const compare = (field: string, from: unknown, to: unknown) => {
    if (from !== to) changes.push({ field, from, to });
  };
  compare('machineNumber', sent.machineNumber, saved.machineNumber);
  compare(
    'occurredAt',
    new Date(sent.occurredAt).toISOString(),
    new Date(saved.occurredAt).toISOString(),
  );
  compare('gameCounter', Number(sent.gameCounter), Number(saved.gameCounter));
  compare('prizeCounter', Number(sent.prizeCounter), Number(saved.prizeCounter));
  compare('testGames', Number(sent.testGames ?? 0), Number(saved.testGames ?? 0));
  compare('notes', sent.notes ?? '', saved.notes ?? '');
  const toys = (lines: ToyLine[] | undefined) =>
    (lines ?? [])
      .filter((line) => line.quantity > 0)
      .map((line) => `${line.toyId}:${line.quantity}`)
      .sort()
      .join(',');
  compare('toys', toys(sent.toys), toys(saved.toys));
  return changes;
}

export interface ApproveInput {
  machineNumber?: string;
  occurredAt?: string;
  gameCounter?: number;
  prizeCounter?: number;
  testGames?: number;
  toys?: ToyLine[];
  notes?: string;
  confirmCounterJump?: boolean;
  confirmPrizeCounterBack?: boolean;
  comment?: string;
}

/**
 * Администратор сохраняет запись как обслуживание — с исправлениями или как есть.
 *
 * Всё в одной транзакции: если сохранение снова не проходит (например, установку аппарата ещё не
 * поправили), запись остаётся на проверке, а администратор получает ту же понятную причину отказа,
 * что раньше получал техник. localId и фото — от техника, визит засчитывается ему же.
 */
export async function approveReview(
  client: Client,
  actor: Actor,
  localId: string,
  edits: ApproveInput,
): Promise<ReviewDetail> {
  assertAdmin(actor);
  const review = await loadReview(client, localId, true);
  if (!review) throw notFound('запись на проверке не найдена');
  if (review.status !== 'PENDING') {
    throw conflict('REVIEW_ALREADY_RESOLVED', 'запись уже разобрана');
  }

  const sent = review.payload;
  const saved: ServiceInput = {
    localId: review.local_id,
    photoObjectKey: review.photo_object_key,
    machineNumber: edits.machineNumber ?? sent.machineNumber,
    occurredAt: edits.occurredAt ?? sent.occurredAt,
    gameCounter: edits.gameCounter ?? sent.gameCounter,
    prizeCounter: edits.prizeCounter ?? sent.prizeCounter,
    testGames: edits.testGames ?? sent.testGames ?? 0,
    toys: edits.toys ?? sent.toys ?? [],
    notes: edits.notes ?? sent.notes,
    // Изменение клешни техника сохраняется вместе с обслуживанием и после проверки (DECISION-090).
    claw: sent.claw,
    confirmCounterJump: edits.confirmCounterJump,
    confirmPrizeCounterBack: edits.confirmPrizeCounterBack,
  };

  // Визит засчитывается технику. Если он с тех пор отключён, createService его не примет как
  // назначенного — тогда обслуживание создаётся без техника и техник проставляется следом, чтобы
  // увольнение не делало его последние черновики неразбираемыми.
  const technician = review.technician_id == null
    ? null
    : (await client.query<{ is_active: boolean }>('SELECT is_active FROM staff WHERE id = $1', [
        review.technician_id,
      ])).rows[0] ?? null;
  const technicianActive = Boolean(technician?.is_active);
  const stored = await createService(client, actor, {
    ...saved,
    technicianId: technicianActive ? Number(review.technician_id) : null,
  });
  const serviceId = Number(stored.service.id);
  if (review.technician_id != null && !technicianActive) {
    const after = await client.query(
      'UPDATE services SET technician_id = $2 WHERE id = $1 RETURNING *',
      [serviceId, review.technician_id],
    );
    await auditUpdate(client, actor, 'service', serviceId, stored.service, after.rows[0]);
  }

  const { confirmCounterJump: _jump, confirmPrizeCounterBack: _prize, ...savedPlain } = saved;
  const changes = diffReview(sent, savedPlain);
  return resolve(client, actor, review, {
    status: 'APPROVED',
    serviceId,
    comment: edits.comment,
    changes,
  });
}

export async function rejectReview(
  client: Client,
  actor: Actor,
  localId: string,
  comment: string | undefined,
): Promise<ReviewDetail> {
  assertAdmin(actor);
  const text = (comment ?? '').trim();
  if (!text) throw badRequest('COMMENT_REQUIRED', 'укажите причину — её увидит техник');
  const review = await loadReview(client, localId, true);
  if (!review) throw notFound('запись на проверке не найдена');
  if (review.status !== 'PENDING') {
    throw conflict('REVIEW_ALREADY_RESOLVED', 'запись уже разобрана');
  }
  return resolve(client, actor, review, { status: 'REJECTED', serviceId: null, comment: text, changes: [] });
}

/**
 * Администратор удаляет запись на проверке целиком — например, техник перепутал аппарат и
 * исправлять там нечего. Только PENDING: разобранная запись — это уже история для техника или
 * ссылка на сохранённое обслуживание. Строка стирается, копия остаётся в аудите. Фото уберёт
 * обычная чистка осиротевших фото.
 */
export async function deleteReview(client: Client, actor: Actor, localId: string): Promise<void> {
  assertAdmin(actor);
  const review = await loadReview(client, localId, true);
  if (!review) throw notFound('запись на проверке не найдена');
  if (review.status !== 'PENDING') {
    throw conflict('REVIEW_ALREADY_RESOLVED', 'запись уже разобрана — удалить можно только ту, что ещё на проверке');
  }
  await client.query('DELETE FROM service_reviews WHERE local_id = $1', [localId]);
  await clearDraftIssue(client, localId);
  await auditDelete(client, actor, 'service_review', localId, review as unknown as Record<string, unknown>);
}

async function resolve(
  client: Client,
  actor: Actor,
  review: ReviewRow,
  outcome: { status: 'APPROVED' | 'REJECTED'; serviceId: number | null; comment?: string; changes: ReviewChange[] },
): Promise<ReviewDetail> {
  const updated = await client.query<ReviewRow>(
    `UPDATE service_reviews
     SET status = $2, service_id = $3, resolved_by = $4, resolved_at = now(),
         admin_comment = $5, changes = $6, updated_at = now()
     WHERE local_id = $1
     RETURNING *`,
    [
      review.local_id,
      outcome.status,
      outcome.serviceId,
      actor.id,
      outcome.comment?.trim() || null,
      JSON.stringify(outcome.changes),
    ],
  );
  await auditUpdate(
    client,
    actor,
    'service_review',
    review.local_id,
    review as unknown as Record<string, unknown>,
    updated.rows[0] as unknown as Record<string, unknown>,
  );
  return getReview(client, actor, review.local_id);
}

export interface MyReviewItem {
  localId: string;
  machineNumber: string;
  machineAddress: string | null;
  occurredAt: Date;
  errorMessage: string;
  status: ReviewStatus;
  adminComment: string | null;
  changes: ReviewChange[];
  resolvedAt: Date | null;
}

/** Техник видит свои записи на проверке и разобранные, по которым ещё не нажал «Понятно». */
export async function listMyReviews(client: Client, actor: Actor): Promise<MyReviewItem[]> {
  const result = await client.query<NamedRow>(
    `${SELECT_WITH_NAMES}
     WHERE r.technician_id = $1
       AND (r.status = 'PENDING' OR r.technician_seen_at IS NULL)
     ORDER BY r.created_at DESC`,
    [actor.id],
  );
  return result.rows.map((row) => ({
    localId: row.local_id,
    machineNumber: row.machine_number,
    machineAddress: row.machine_address,
    occurredAt: row.occurred_at,
    errorMessage: row.error_message,
    status: row.status,
    adminComment: row.admin_comment,
    changes: row.changes,
    resolvedAt: row.resolved_at,
  }));
}

export async function markReviewSeen(client: Client, actor: Actor, localId: string): Promise<void> {
  const review = await loadReview(client, localId);
  if (!review) throw notFound('запись на проверке не найдена');
  if (Number(review.technician_id) !== Number(actor.id)) throw forbidden('это запись другого техника');
  if (review.status === 'PENDING') {
    throw badRequest('REVIEW_PENDING', 'запись ещё не разобрана администратором');
  }
  await client.query(
    'UPDATE service_reviews SET technician_seen_at = COALESCE(technician_seen_at, now()) WHERE local_id = $1',
    [localId],
  );
}
