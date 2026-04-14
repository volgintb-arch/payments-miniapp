// src/lib/adesk/client.ts
// Adesk API клиент с логированием и retry на 429.
//
// Особенности Adesk API:
//   - v1 эндпоинты: Content-Type: application/x-www-form-urlencoded
//   - v2 эндпоинты: Content-Type: application/json
//   - Авторизация через ?api_token=<token> в query string
//   - При 429 — retry с экспоненциальной задержкой (1s, 3s, 10s)

import type {
  AdeskResponse,
  AdeskCategory,
  AdeskCategoryGroup,
  AdeskContractor,
  AdeskTransaction,
  AdeskBankAccount,
  AdeskWebhook,
} from './types';

const BASE = process.env.ADESK_API_BASE || 'https://api.adesk.ru';
const TOKEN = process.env.ADESK_API_TOKEN || '';

const RETRY_DELAYS = [1000, 3000, 10000];

async function request<T>(
  method: 'GET' | 'POST',
  endpoint: string,
  opts: {
    body?: Record<string, unknown>;
    format?: 'form' | 'json';
  } = {},
): Promise<AdeskResponse<T>> {
  const url = new URL(`${BASE}${endpoint}`);
  url.searchParams.set('api_token', TOKEN);

  const headers: Record<string, string> = {};
  let body: string | undefined;

  if (method === 'POST' && opts.body) {
    if (opts.format === 'json') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(
        Object.entries(opts.body).reduce(
          (acc, [k, v]) => {
            if (v !== undefined && v !== null) acc[k] = String(v);
            return acc;
          },
          {} as Record<string, string>,
        ),
      ).toString();
    }
  }

  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await fetch(url.toString(), { method, headers, body });

    if (res.status === 429) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      throw new Error(`Adesk rate limit exceeded after ${attempt + 1} attempts`);
    }

    const data = (await res.json()) as AdeskResponse<T>;
    return data;
  }

  throw new Error('Adesk request failed: unreachable');
}

export const adesk = {
  // ===== Категории =====
  // full_group=true возвращает группы с вложенными категориями
  getCategories: (opts?: { type?: 'outcome' | 'income'; fullGroup?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.type) params.set('type', opts.type);
    if (opts?.fullGroup) params.set('full_group', 'true');
    const qs = params.toString();
    return request<{ categories: AdeskCategory[]; groups?: AdeskCategoryGroup[] }>(
      'GET',
      `/v1/transactions/categories${qs ? `?${qs}` : ''}`,
    );
  },

  // ===== Контрагенты =====
  searchContractors: (query: string) =>
    request<{ contractors: AdeskContractor[] }>(
      'GET',
      `/v1/contractors?q=${encodeURIComponent(query)}&reduced=true`,
    ),

  createContractor: (name: string) =>
    request<{ contractor: AdeskContractor }>(
      'POST',
      '/v1/contractor',
      { body: { name }, format: 'form' },
    ),

  // ===== Счета / юрлица =====
  getBankAccounts: () =>
    request<{ bankAccounts: AdeskBankAccount[] }>('GET', '/v1/bank-accounts'),

  getLegalEntities: () =>
    request<{ legalEntities: Array<{ id: number; name: string }> }>('GET', '/v1/legal-entities'),

  // ===== Операции =====
  listTransactions: (params: {
    status?: 'completed' | 'planned' | 'all';
    type?: 'outcome' | 'income';
    bankAccount?: number;
    rangeStart?: string; // YYYY-MM-DD
    rangeEnd?: string;
  }) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.type) q.set('type', params.type);
    if (params.bankAccount) q.set('bank_account', String(params.bankAccount));
    if (params.rangeStart) {
      q.set('range', 'custom');
      q.set('range_start', params.rangeStart);
      q.set('range_end', params.rangeEnd || params.rangeStart);
    }
    const qs = q.toString();
    return request<{ transactions: AdeskTransaction[] }>(
      'GET',
      `/v1/transactions${qs ? `?${qs}` : ''}`,
    );
  },

  // ===== Проекты =====
  getProjects: () =>
    request<{ projects: Array<{
      id: number;
      name: string;
      isArchived: boolean;
      isFinished: boolean;
      category: { id: number; name: string } | null;
    }> }>('GET', '/v1/projects'),

  updateTransaction: (id: number, updates: {
    categoryId?: number;
    contractorId?: number;
    projectId?: number;
    description?: string;
  }) =>
    request<{ transactions: AdeskTransaction[] }>(
      'POST',
      '/v2/transactions/update',
      {
        format: 'json',
        body: {
          transactions: [{ id, ...updates }],
        },
      },
    ),

  // ===== Вебхуки =====
  createWebhook: (url: string, events: string[], description: string) =>
    request<{ webhook: AdeskWebhook }>(
      'POST',
      '/v1/webhook',
      {
        format: 'form',
        body: {
          url,
          events: events.join(','),
          description,
        },
      },
    ),

  listWebhooks: () =>
    request<{ webhooks: AdeskWebhook[] }>('GET', '/v1/webhooks'),
};
