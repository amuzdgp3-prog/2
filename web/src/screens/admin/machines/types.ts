export interface RentPeriod {
  id: number;
  location_id: number;
  monthly_amount: string;
  started_at: string;
  ended_at: string | null;
}
