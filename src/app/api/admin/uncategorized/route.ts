// GET /api/admin/uncategorized?days=30
// Возвращает outcome-транзакции Adesk без категории и без проекта
// («неопознанные»), которые ещё не привязаны к какому-либо Payment.
// Для вкладки «Неопознанные» в мини-аппе — сотрудник разносит их вручную.
//
// Доступ: Bearer CRON_SECRET или любой авторизованный сотрудник (активный
// JWT). Разнос транзакции — POST [txId]/assign — ограничен юнитами
// пользователя, см. соседний route.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { denyUnlessAuthed } from '@/lib/api-helpers';
import { isCardTransaction } from '@/lib/retro-match';
import { fetchOmgUncategorized, omgEnabled } from '@/lib/omg/client';

// Список видит любой авторизованный сотрудник: разносить «неопознанные»
// транзакции — общая работа, а не только админская. Ограничения остаются
// два: EXCLUDED_CARDS убирает служебные карты бухгалтерии из выдачи, а
// разнос в чужой юнит отсекается проверкой userUnit в [txId]/assign.
const DEFAULT_DAYS = 7;
const MAX_ITEMS = 500;
const CACHE_TTL_MS = 60_000;

// Карты (последние 4 цифры), которые НЕ выводим в этой вкладке. Обычно —
// служебные/чужие карты бухгалтерии, разносить которые сотрудник не должен.
// Дефолт зашит в код + расширяется через ENV `UNCATEGORIZED_EXCLUDE_CARDS`
// (comma-separated, напр. "8611,1234"). Не забудь перезапустить pm2 после
// правки .env. Теперь это единственный фильтр видимости в выдаче — вкладку
// открыли всем сотрудникам, так что список карт держи в актуальном виде.
const EXCLUDED_CARDS = new Set<string>([
  '8611',
  ...(process.env.UNCATEGORIZED_EXCLUDE_CARDS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
]);

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
  const denied = await denyUnlessAuthed(request);
  if (denied) return denied;

  const daysParam = Number(request.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 180
    ? daysParam
    : DEFAULT_DAYS;
  // withNonCard=1 отключал фильтр «только карточные» и показывал ЛЮБОМУ
  // сотруднику все некарточные расходы (переводы бухгалтерии, оплаты
  // контрагентам) — их не прикрывает даже EXCLUDED_CARDS (нет маски карты).
  // UI этот параметр не использует, поэтому поддержку убираем: всегда card-only.
  const withNonCard = false;
  const noCache = request.nextUrl.searchParams.get('nocache') === '1';
  // source=omg — тот же список, но из omg-finance (наша система учёта).
  // Пока Adesk основной, вкладка умеет показывать оба источника, чтобы их
  // сравнивать. txId в этом режиме — id операции omg-finance (строка).
  const source = request.nextUrl.searchParams.get('source') === 'omg' ? 'omg' : 'adesk';

  const cacheKey = `${source}|${days}|${withNonCard ? 1 : 0}`;
  if (!noCache) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return Response.json(hit.body);
    }
  }

  type RawItem = {
    txId: number | string;
    amount: number;
    date: string;
    description: string;
    isCard: boolean;
    cardSuffix: string | null;
    bankAccount: { id: number; name: string; legalEntity: string | null };
  };
  let availableRaw: RawItem[];

  if (source === 'omg') {
    const { items } = await fetchOmgUncategorized(days, withNonCard);
    availableRaw = items.filter((it) => !(it.cardSuffix && EXCLUDED_CARDS.has(it.cardSuffix)));
  } else {
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

    // Фильтруем: без категории И без проекта, + только карточные (если не withNonCard),
    // + не в EXCLUDED_CARDS (сотрудникам не должны показываться).
    const uncategorized = allTxs.filter(({ tx }) => {
      if (tx.category || tx.project) return false;
      if (!withNonCard && !isCardTransaction(tx.description)) return false;
      const cardMatch = /\d{4,6}\*+(\d{4})\b/.exec(tx.description || '');
      if (cardMatch && EXCLUDED_CARDS.has(cardMatch[1])) return false;
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

    const availableRawAdesk = uncategorized.filter(({ tx }) => !takenSet.has(tx.id));
    availableRaw = availableRawAdesk.map(({ baId, tx }) => {
      const ba = baById.get(baId);
      const cardMatch = /\d{4,6}\*+(\d{4})\b/.exec(tx.description || '');
      return {
        txId: tx.id,
        amount: Math.abs(Number(tx.amount)),
        date: tx.date,
        description: tx.description || '',
        isCard: isCardTransaction(tx.description),
        cardSuffix: cardMatch ? cardMatch[1] : null,
        bankAccount: { id: baId, name: ba?.name ?? '—', legalEntity: ba?.legalEntity?.name ?? null },
      };
    });
  }
  const totalAvailable = availableRaw.length;

  // Ищем «висящие» платежи сотрудников (PENDING_RETRO/NEEDS_REVIEW/ORPHANED)
  // за последние 45 дней. По каждой tx потом ищем среди них того, у кого
  // совпадают: сумма + cardNote (4 цифры) + дата в ±4 дня от tx. Если такой
  // Payment есть, помечаем tx маркером «уже подан» — фронт покажет warning
  // и потребует подтверждение перед разносом, чтобы не плодить дубли.
  const hangingCutoff = new Date(Date.now() - 45 * 86_400_000);
  const hangingPayments = await prisma.payment.findMany({
    where: {
      status: { in: ['PENDING_RETRO', 'NEEDS_REVIEW', 'ORPHANED'] },
      paymentMethod: 'card',
      createdAt: { gte: hangingCutoff },
    },
    select: {
      id: true, amount: true, date: true, cardNote: true, description: true, status: true,
      user: { select: { telegramUsername: true, firstName: true } },
    },
  });

  function findHangingFor(txDateStr: string, txAmount: number, cardSuffix: string | null) {
    // txDateStr — "DD.MM.YYYY"
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(txDateStr);
    if (!m) return null;
    const txDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    const lo = txDate.getTime() - 4 * 86_400_000;
    const hi = txDate.getTime() + 4 * 86_400_000;
    for (const p of hangingPayments) {
      if (Math.abs(Number(p.amount) - txAmount) >= 0.01) continue;
      if (cardSuffix && (p.cardNote || '').trim() !== cardSuffix) continue;
      const t = p.date.getTime();
      if (t < lo || t > hi) continue;
      const tag = p.user.telegramUsername ? `@${p.user.telegramUsername}` : p.user.firstName;
      return {
        id: p.id,
        userTag: tag,
        date: p.date.toISOString().slice(0, 10),
        description: p.description,
        status: p.status,
      };
    }
    return null;
  }

  const items = availableRaw
    .map((it) => ({
      ...it,
      source,
      pendingPayment: findHangingFor(it.date, it.amount, it.cardSuffix),
    }))
    .sort((a, b) => {
      // Сортировка по дате (DD.MM.YYYY) — новее сверху
      const parse = (s: string) => {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
        return m ? Number(m[3] + m[2] + m[1]) : 0;
      };
      return parse(b.date) - parse(a.date);
    })
    .slice(0, MAX_ITEMS);

  // total = сколько НАЙДЕНО неопознанных до отсечения limit'ом. items.length —
  // сколько реально ушло в ответ. Если total > items.length, UI должен намекнуть
  // «показано X из Y» и/или предложить расширить период.
  const body = { items, days, total: totalAvailable, shown: items.length, source, omgAvailable: omgEnabled() };
  cache.set(cacheKey, { at: Date.now(), body });
  return Response.json(body);
}
