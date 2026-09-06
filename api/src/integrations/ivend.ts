/**
 * Клиент кабинета iVend (cabinet.ivend.pro) — реверс-инжинирен из реальных GraphQL-запросов
 * самого веб-кабинета (не задокументирован публично). Никакой браузерной автоматизации: кабинет
 * отдаёт обычный аутентифицированный GraphQL, включая уже готовое разделение нал/безнал и
 * построчные транзакции со стабильным id — скрейпинг DOM/CSV не нужен.
 *
 * Найденные поля:
 * - userLogin(input: {phone, password}) -> { data: { token }, response: { status, message } } —
 *   status/message используются для распознавания неверного логина/пароля, а не HTTP-кода.
 * - getMachinesSales(filter: {zeroSales, groups, period}, pagination) -> machines[].controller.uid
 *   — это и есть «номер терминала», который вводится в нашей системе; machines[].id — внутренний
 *   machineId iVend. Один вызов с zeroSales:false и один с zeroSales:true дают полный список.
 * - getSalesByMachine(machineId, filter:{period}, pagination) -> sales[] = { id, type: 'CASH'|
 *   'CASHLESS', price, createdAt (epoch ms) } — построчные транзакции с готовым типом оплаты.
 */

// Overridable so tests can point this at a local fake server instead of the real provider.
const GRAPHQL_URL = process.env.IVEND_GRAPHQL_URL ?? 'https://graphql.ivend.pro/graphql';

async function callGraphQL<T>(
  token: string | null,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e: { message: string }) => e.message).join('; '));
  }
  return body.data as T;
}

export interface IvendLoginResult {
  ok: boolean;
  token?: string;
  message?: string;
}

const LOGIN_MUTATION = `mutation userLogin($input: RequestTokenInput!) {
  userLogin(input: $input) {
    data { phone token role companyName __typename }
    response { status message __typename }
    __typename
  }
}`;

/** Логин по номеру телефона и паролю. Неверные данные — деловой результат (response.status), не HTTP-ошибка. */
export async function ivendLogin(phone: string, password: string): Promise<IvendLoginResult> {
  try {
    const data = await callGraphQL<{ userLogin: { data: { token: string } | null; response: { status: string; message: string } } }>(
      null,
      'userLogin',
      LOGIN_MUTATION,
      { input: { phone, password } },
    );
    const result = data.userLogin;
    if (result.data?.token) return { ok: true, token: result.data.token };
    return { ok: false, message: result.response?.message || 'логин или пароль не приняты кабинетом iVend' };
  } catch (error) {
    return { ok: false, message: `нет связи с кабинетом iVend: ${(error as Error).message}` };
  }
}

const MACHINES_SALES_QUERY = `query getMachinesSales($filter: MachinesSalesFilterInput, $sort: SortInput, $pagination: PaginationInput!, $forceUpdate: Boolean) {
  getMachinesSales(filter: $filter, sort: $sort, pagination: $pagination, forceUpdate: $forceUpdate) {
    machines {
      id name
      controller { id uid __typename }
      __typename
    }
    pages { totalPages totalRecords __typename }
    __typename
  }
}`;

export interface IvendMachine {
  machineId: number;
  name: string;
  terminalUid: string | null;
}

/**
 * Полный список аппаратов аккаунта с их machineId и «Устройство телеметрии» (uid) — это и есть
 * серийный номер терминала, который админ вводит в нашей системе при создании терминала. Два
 * прохода (zeroSales false/true), так как флаг переключает «есть продажи»/«нет продаж», а не
 * «включать нулевые».
 */
export async function fetchIvendMachines(token: string): Promise<{ machines: IvendMachine[]; pagesFetched: number }> {
  const all: IvendMachine[] = [];
  let pagesFetched = 0;
  for (const zeroSales of [false, true]) {
    for (let page = 0; page < 20; page += 1) {
      const data = await callGraphQL<{
        getMachinesSales: { machines: Array<{ id: number; name: string; controller: { uid: string } | null }> };
      }>(token, 'getMachinesSales', MACHINES_SALES_QUERY, {
        filter: { name: '', zeroSales, groups: [], globalSearch: '', period: { from: 0, to: Date.now() } },
        sort: { sortField: 'name', sortOrder: 'ASC' },
        pagination: { page, pageSize: 100 },
        forceUpdate: false,
      });
      pagesFetched += 1;
      const machines = data.getMachinesSales.machines;
      if (machines.length === 0) break;
      for (const m of machines) {
        all.push({ machineId: m.id, name: m.name, terminalUid: m.controller?.uid ?? null });
      }
      if (machines.length < 100) break;
    }
  }
  return { machines: all, pagesFetched };
}

const SALES_BY_MACHINE_QUERY = `query getSalesByMachine($filter: MachineSalesFilterInput!, $sort: SortInput!, $machineId: Int!, $pagination: PaginationInput!) {
  getSalesByMachine(filter: $filter, sort: $sort, pagination: $pagination, machineId: $machineId) {
    sales { id type price createdAt __typename }
    pages { totalPages totalRecords __typename }
    __typename
  }
}`;

export interface IvendSale {
  id: number;
  type: 'CASH' | 'CASHLESS' | string;
  price: number;
  createdAtMs: number;
}

/** Построчные продажи одного аппарата за период (мс, включая обе границы), с пагинацией. */
export async function fetchIvendSales(
  token: string,
  machineId: number,
  fromMs: number,
  toMs: number,
): Promise<{ sales: IvendSale[]; pagesFetched: number }> {
  const all: IvendSale[] = [];
  let pagesFetched = 0;
  for (let page = 0; page < 200; page += 1) {
    const data = await callGraphQL<{
      getSalesByMachine: { sales: Array<{ id: number; type: string; price: number; createdAt: number }> };
    }>(token, 'getSalesByMachine', SALES_BY_MACHINE_QUERY, {
      machineId,
      filter: { name: '', type: null, period: { from: fromMs, to: toMs } },
      sort: { sortField: 'createdAt', sortOrder: 'DESC' },
      pagination: { page, pageSize: 200 },
    });
    pagesFetched += 1;
    const sales = data.getSalesByMachine.sales;
    if (sales.length === 0) break;
    for (const s of sales) all.push({ id: s.id, type: s.type, price: s.price, createdAtMs: s.createdAt });
    if (sales.length < 200) break;
  }
  return { sales: all, pagesFetched };
}
