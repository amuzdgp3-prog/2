export interface ServiceRow {
  id: number;
  service_date: string;
  occurred_at: string;
  game_counter: number;
  prize_counter: number;
  test_games: number;
  new_games: string;
  new_prizes: number;
  revenue: string;
  cash_amount: string;
  cashless_amount: string;
  toy_cost: string;
  counter_divisor_applied: string;
  price_per_game_snapshot: string;
  revenue_to_cost_ratio: string | null;
  is_financial_anomaly: boolean;
  photo_object_key: string;
  notes: string;
  kind: string;
  technician_name: string | null;
  location_name: string;
  toys: { toyId: number; name: string; quantity: number; unitCost: string }[] | null;
}
