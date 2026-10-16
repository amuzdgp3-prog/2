/**
 * Обслуживания на проверке у администратора (DECISION-086). Зеркало типов из
 * api/src/commands/serviceReviews.ts.
 */
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReviewChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** Ответ GET /api/service-reviews/mine — то, что видит техник. */
export interface MyReviewItem {
  localId: string;
  machineNumber: string;
  machineAddress: string | null;
  occurredAt: string;
  errorMessage: string;
  status: ReviewStatus;
  adminComment: string | null;
  changes: ReviewChange[];
  resolvedAt: string | null;
}

export interface ToyLine {
  toyId: number;
  quantity: number;
}

export interface ReviewPayload {
  localId: string;
  machineNumber: string;
  occurredAt: string;
  gameCounter: number;
  prizeCounter: number;
  testGames?: number;
  toys?: ToyLine[];
  notes?: string;
  photoObjectKey: string;
}

/** Ответ GET /api/service-reviews и /api/service-reviews/:localId — то, что видит администратор. */
export interface ReviewListItem {
  localId: string;
  technicianId: number | null;
  technicianName: string | null;
  machineNumber: string;
  machineAddress: string | null;
  occurredAt: string;
  errorCode: string;
  errorMessage: string;
  status: ReviewStatus;
  serviceId: number | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  adminComment: string | null;
  changes: ReviewChange[];
  createdAt: string;
}

export interface ReviewDetail extends ReviewListItem {
  payload: ReviewPayload;
  photoObjectKey: string;
}

const FIELD_LABELS: Record<string, string> = {
  machineNumber: 'аппарат',
  occurredAt: 'дата',
  gameCounter: 'счётчик игр',
  prizeCounter: 'счётчик призов',
  testGames: 'тестовые игры',
  notes: 'заметка',
  toys: 'игрушки',
};

const formatValue = (field: string, value: unknown): string => {
  if (field === 'occurredAt' && typeof value === 'string') {
    return new Date(value).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  if (value === '' || value == null) return '—';
  return String(value);
};

/** «счётчик игр: 1025 → 1052». Игрушки показываются без чисел — там идентификаторы, а не названия. */
export function describeChange(change: ReviewChange): string {
  const label = FIELD_LABELS[change.field] ?? change.field;
  if (change.field === 'toys') return `${label}: исправлены`;
  return `${label}: ${formatValue(change.field, change.from)} → ${formatValue(change.field, change.to)}`;
}
