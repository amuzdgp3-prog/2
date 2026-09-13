export interface Machine {
  machine_number: string;
  machine_type: string;
  model: string;
  price_per_game: string;
  counter_divisor: string;
  status: string;
  min_service_days: number | null;
  max_service_days: number | null;
  location_id: number | null;
  location_name: string | null;
  address: string | null;
  terminal_id: number | null;
  terminal_serial: string | null;
  default_toy_set_id: number | null;
  default_toy_set_name: string | null;
}

export interface Toy {
  id: number;
  name: string;
  unit_cost: string;
  is_active: boolean;
}

export interface ToySet {
  id: number;
  name: string;
  items: Array<{ toyId: number; name: string; quantity: number }>;
}

export interface Terminal {
  id: number;
  serial: string;
  provider: string;
  status: string;
  bound_machine: string | null;
}

export interface Location {
  id: number;
  name: string;
  timezone: string;
  status: string;
  parent_id: number | null;
}

export interface TabProps {
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}

export interface Classifier {
  id: number;
  name: string;
  parent_id: number | null;
  locations: Array<{ id: number; name: string }>;
  machines: string[];
}

/**
 * Каталог — единственный инструмент организации аппаратов и адресов (город/район/тип/этаж —
 * любой признак, с произвольной вложенностью и множественной принадлежностью одному узлу сразу
 * несколько адресов/аппаратов, а одному адресу или аппарату — несколько узлов). Заменяет собой
 * прежнее дерево Точек как рабочий способ организации: тег на адресе действует, пока аппарат там
 * стоит, тег на конкретном аппарате — независимо от адреса (см. lib/scope.ts на сервере).
 */
