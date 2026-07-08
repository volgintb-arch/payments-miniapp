// GET /api/admin/uncategorized?days=30
// Возвращает outcome-транзакции Adesk без категории и без проекта
// («неопознанные»), которые ещё не привязаны к какому-либо Payment.
// Для страницы «Неопознанные» в мини-аппе — админ разносит их вручную.
//
// Доступ: Bearer CRON_SECRET или JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { getAuthUser } from '@/lib/api-helpers';
import { isCardTransaction } from '@/lib/retro-match';

const CRON_SECRET = process.env.CRON_SECRET || '';
const DEFAULT_DAYS = 7;
const MAX_ITEMS = 100;
const CACHE_TTL_MS = 60_000;

// Простой in-memory кэш: список неопознанных tx стоит на большом окне
// десятки секунд собирать (14 банк-счетов × Adesk latency), а после
// разноса одной tx админ обычно тут же жмёт «Обновить» ещё раз. Держим
// последний результат 60 секунд, разные (days, withNonCard) в отдельных
// ключах. Кэш сбрасывается при рестарте pm2 — этого достаточно.
const cache = new Map<string, { at: number; body: unknown }>();

export async function GET(request: NextRequest) {
  try {
    return await handleGet(request);
  } catch (err) {
    console.error('[admin/uncategorized] fatal:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}

async function handleGet(request: NextRequest) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const daysParam = Number(request.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 180
    ? daysParam
    : DEFAULT_DAYS;
  const withNonCard = request.nextUrl.searchParams.get('withNonCard') === '1';
  const noCache = request.nextUrl.searchParams.get('nocache') === '1';

  const cacheKey = `${days}|${withNonCard ? 1 : 0}`;
  if (!noCache) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return Response.json(hit.body);
    }
  }

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - days);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const bankAccounts = (await adesk.getBankAccounts()).bankAccounts || [];
  const baById = new Map(bankAccounts.map((b) => [b.id, b]));

  // Идём пакетами по 3 — Adesk на четвертом-пятом параллельном запросе
  // начинает тайм-аутить (видели в rematch-логе). 3 — нагрузка комфортная.
  const allTxs: { baId: number; tx: import('@/lib/adesk/types').AdeskTransaction }[] = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < bankAccounts.length; i += CONCURRENCY) {
    const batch = bankAccounts.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((ba) =>
        adesk.listTransactions({
          status: 'completed',
          type: 'outcome',
          bankAccount: ba.id,
          rangeStart: fmt(start),
          rangeEnd: fmt(today),
        }).then((res) => ({ baId: ba.id, txs: res.transactions || [] })),
      ),
    );
    for (const r of results) {
      if (r.status !== 'fulfilled') {
        console.error('[admin/uncategorized] listTransactions failed:', r.reason);
        continue;
      }
      for (const tx of r.value.txs) {
        allTxs.push({ baId: r.value.baId, tx });
      }
    }
  }

  // Фильтруем: без категории И без проекта, + только карточные (если не withNonCard).
  // Наличные/платёжки бухгалтера сюда не нужны — разносить их из мини-аппа
  // всё равно негде. Флаг ?withNonCard=1 отключает card-фильтр.
  const uncategorized = allTxs.filter(({ tx }) => {
    if (tx.category || tx.project) return false;
    if (!withNonCard && !isCardTransaction(tx.description)) return false;
    return true;
  });

  // Убираем те, которые уже привязаны к какому-либо Payment в БД
  // (у Adesk-tx категории может не быть, а связь у нас есть — не показываем).
  const txIds = uncategorized.map(({ tx }) => tx.id);
  const taken = txIds.length
    ? await prisma.payment.findMany({
        where: { adeskConfirmedTransactionId: { in: txIds } },
        select: { adeskConfirmedTransactionId: true },
      })
    : [];
  const takenSet = new Set(
    taken.map((t) => t.adeskConfirmedTransactionId).filter(Boolean) as number[],
  );

  const items = uncategorized
    .filter(({ tx }) => !takenSet.has(tx.id))
    .map(({ baId, tx }) => {
      const ba = baById.get(baId);
      const cardMatch = /\*+(\d{4})\b/.exec(tx.description || '');
      return {
        txId: tx.id,
        amount: Math.abs(Number(tx.amount)),
        date: tx.date, // "DD.MM.YYYY"
        description: tx.description || '',
        isCard: isCardTransaction(tx.description),
        // 4 цифры карты из маски «220445****NNNN» (для фильтра в UI)
        cardSuffix: cardMatch ? cardMatch[1] : null,
        bankAccount: {
          id: baId,
          name: ba?.name ?? '—',
          legalEntity: ba?.legalEntity?.name ?? null,
        },
      };
    })
    .sort((a, b) => {
      // Сортировка по дате (DD.MM.YYYY) — новее сверху
      const parse = (s: string) => {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
        return m ? Number(m[3] + m[2] + m[1]) : 0;
      };
      return parse(b.date) - parse(a.date);
    })
    .slice(0, MAX_ITEMS);

  const body = { items, days, total: items.length };
  cache.set(cacheKey, { at: Date.now(), body });
  return Response.json(body);
}

function isAuthorized(request: NextRequest): boolean {
  const auth = request.headers.get('authorization');
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const user = getAuthUser(request);
  return user?.role === 'ADMIN';
}
