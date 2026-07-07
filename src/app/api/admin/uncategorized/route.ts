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
const DEFAULT_DAYS = 30;
const MAX_ITEMS = 100;

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

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - days);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const bankAccounts = (await adesk.getBankAccounts()).bankAccounts || [];
  const baById = new Map(bankAccounts.map((b) => [b.id, b]));

  // Идём пакетами по 5, как в матчере.
  const allTxs: { baId: number; tx: import('@/lib/adesk/types').AdeskTransaction }[] = [];
  const CONCURRENCY = 5;
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

  // Наличные/платёжки бухгалтера сюда не нужны — разносить их из мини-аппа
  // всё равно негде (нужен sейф или сложные атрибуты). Оставляем только
  // карточные операции (маска карты или «Терминал» в описании).
  // Флаг ?withNonCard=1 отключает фильтр — на случай если админ захочет
  // увидеть весь список.
  const withNonCard = request.nextUrl.searchParams.get('withNonCard') === '1';

  // Фильтруем: без категории И без проекта, + только карточные (если не withNonCard).
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
      return {
        txId: tx.id,
        amount: Math.abs(Number(tx.amount)),
        date: tx.date, // "DD.MM.YYYY"
        description: tx.description || '',
        isCard: isCardTransaction(tx.description),
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

  return Response.json({ items, days, total: items.length });
}

function isAuthorized(request: NextRequest): boolean {
  const auth = request.headers.get('authorization');
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const user = getAuthUser(request);
  return user?.role === 'ADMIN';
}
