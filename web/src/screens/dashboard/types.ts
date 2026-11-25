export interface RevenueParts { cash: string; cashless: string }
export interface RevenueRow extends RevenueParts { machineNumber: string; locationName: string; revenue: string }
export interface RoiRow { machineNumber: string; locationName: string; roi: string }
export type RevenuePeriod = 'monthToDate' | 'weekToDate' | 'lastMonth' | 'yearToDate';
export interface DashboardData {
  counts: { activeMachines: number; totalMachines: number; activeTerminals: number; totalTerminals: number };
  revenue: Record<RevenuePeriod, string>;
  revenueBreakdown: Record<RevenuePeriod, RevenueParts>;
  topRevenue: RevenueRow[];
  worstRevenue: RevenueRow[];
  topRoi: RoiRow[];
  worstRoi: RoiRow[];
}
/** Mirrors the read-only dailySummary API; the same rows feed Telegram. */
export interface DailySummary {
  date: string;
  technicians: Array<{ name: string; machines: number; start: string; finish: string; cash: number; cashless: number }>;
}
