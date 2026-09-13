export interface StaffRow {
  id: number;
  login: string;
  full_name: string;
  role: 'ADMIN' | 'TECHNICIAN' | 'BOSS';
  is_active: boolean;
  is_field_technician: boolean;
}

export const ROLE_LABELS: Record<StaffRow['role'], string> = {
  ADMIN: 'Администратор',
  TECHNICIAN: 'Техник',
  BOSS: 'Руководитель (только чтение)',
};
