'use client';

// Хук для API-запросов с JWT из localStorage.

const API_BASE = '';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

export function setToken(token: string) {
  localStorage.setItem('token', token);
}

export function clearToken() {
  localStorage.removeItem('token');
}

const REQUEST_TIMEOUT_MS = 30_000;

// timeoutMs — для заведомо долгих эндпоинтов. Дефолтные 30 секунд рассчитаны
// на обычный CRUD; запросы, которые ходят в Adesk по всем банк-счетам, в них
// не укладываются и рвутся на середине (см. /api/admin/uncategorized).
export type ApiFetchOptions = RequestInit & { timeoutMs?: number };

export async function apiFetch<T>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const { timeoutMs, ...init } = opts;
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Таймаут через AbortController — иначе fetch может висеть бесконечно
  // (плохой LTE, зависший upstream), а пользователь видит вечную «Загрузку…».
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Сервер не отвечает. Проверьте интернет и попробуйте снова.');
    }
    throw err;
  }
  clearTimeout(timeoutId);

  // 401 = сессии нет (истёк/битый токен, пользователь деактивирован) —
  // единственный случай, когда сброс токена и перезагрузка уместны. Промах
  // по роли сервер обязан отдавать 403, иначе он молча разлогинит человека:
  // см. denyUnlessRole в lib/api-helpers.ts.
  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('Unauthorized');
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Сервер вернул не-JSON (обычно HTML от nginx 502/504) — покажем понятно.
    throw new Error(`Сервер ответил не в формате JSON (HTTP ${res.status}). Возможно, идёт долгая операция.`);
  }
  if (!res.ok) {
    const errObj = data as { error?: string };
    throw new Error(errObj.error || `API error (HTTP ${res.status})`);
  }
  return data as T;
}
