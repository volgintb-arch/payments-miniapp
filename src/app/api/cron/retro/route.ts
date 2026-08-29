// GET /api/cron/retro
// Крон-обработчик всех незавершённых платежей:
//   - card + PENDING_RETRO  → ретро-матч с банковской операцией
//   - cash + PENDING_RETRO  → повторная попытка создать транзакцию в Adesk
// Через 5 дней без успеха → ORPHANED.

import { prisma } from '@/lib/db';
import { processRetroMatch } from '@/lib/retro-match';
import { sendToGroup } from '@/lib/telegram';
import { denyUnlessCronSecret, isUniqueViolation } from '@/lib/api-helpers';
import { createTransactionIdempotent } from '@/lib/adesk/idempotent';

const STALE_NOTIFY_HOURS = 24;
const ORPHAN_AFTER_DAYS = 5;

// Инкремент попытки и перевод в ORPHANED после ORPHAN_AFTER_DAYS без успеха.
async function bumpAttemptAndMaybeOrphan(payment: { id: string; createdAt: Date }) {
  await prisma.payment.update({
    where: { id: payment.id },
    data: { retroAttempts: { increment: 1 }, lastRetroAttemptAt: new Date() },
  });
  const days = (Date.now() - payment.createdAt.getTime()) / (1000 * 60 * 60 * 24);
  if (days >= ORPHAN_AFTER_DAYS) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'ORPHANED' } });
  }
}

export async function GET(request: Request) {
  const denied = denyUnlessCronSecret(request);
  if (denied) return denied;

  const pendingPayments = await prisma.payment.findMany({
    where: { status: 'PENDING_RETRO' },
    orderBy: { createdAt: 'asc' },
    include: { splits: true },
  });

  const results: { paymentId: string; method: string; result: string }[] = [];

  for (const payment of pendingPayments) {
    try {
      if (payment.paymentMethod === 'cash') {
        if (!payment.adeskSafeId) {
          // Раньше no_safe даже не инкрементил попытки — платёж висел вечно.
          await bumpAttemptAndMaybeOrphan(payment);
          results.push({ paymentId: payment.id, method: 'cash', result: 'no_safe' });
          continue;
        }

        // Сплиты не теряем: со сплитами шлём parts[] (как при первичном
        // создании), иначе вся сумма легла бы одной строкой на статью
        // первого сплита. Создание идемпотентно: перед вставкой ищем уже
        // созданную транзакцию, чтобы таймаут+ретрай не задваивали расход.
        const hasSplits = payment.splits.length > 0;
        const { txId, reused } = await createTransactionIdempotent({
          amount: Number(payment.amount),
          date: payment.date.toISOString().split('T')[0],
          type: 'outcome',
          bankAccountId: payment.adeskSafeId,
          description: payment.description ?? undefined,
          ...(hasSplits
            ? {
                parts: payment.splits.map((s) => ({
                  amount: Number(s.amount),
                  categoryId: s.adeskCategoryId,
                  projectId: s.adeskProjectId ?? undefined,
                  contractorId: s.adeskContractorId ?? undefined,
                  description: s.description ?? undefined,
                })),
              }
            : {
                categoryId: payment.adeskCategoryId,
                projectId: payment.adeskProjectId ?? undefined,
                contractorId: payment.adeskContractorId ?? undefined,
              }),
        });

        if (txId) {
          try {
            await prisma.payment.update({
              where: { id: payment.id },
              data: {
                status: 'MATCHED',
                adeskConfirmedTransactionId: txId,
                matchedAt: new Date(),
                retroAttempts: { increment: 1 },
                lastRetroAttemptAt: new Date(),
              },
            });
            results.push({ paymentId: payment.id, method: 'cash', result: reused ? 'reused' : 'created' });
          } catch (err) {
            if (isUniqueViolation(err)) {
              // Найденная/созданная tx уже привязана к другому платежу.
              await prisma.payment.update({
                where: { id: payment.id },
                data: { status: 'NEEDS_REVIEW', retroAttempts: { increment: 1 }, lastRetroAttemptAt: new Date() },
              });
              results.push({ paymentId: payment.id, method: 'cash', result: 'conflict' });
            } else {
              throw err;
            }
          }
        } else {
          // Создание прошло (клиент бросил бы на ошибке), но id не распарсился.
          // НЕ ретраим создание — иначе дубль. Отправляем на ручной разбор.
          await prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'NEEDS_REVIEW', retroAttempts: { increment: 1 }, lastRetroAttemptAt: new Date() },
          });
          results.push({ paymentId: payment.id, method: 'cash', result: 'no_id_review' });
        }
      } else {
        const result = await processRetroMatch(payment.id);
        results.push({ paymentId: payment.id, method: 'card', result: result.status });
      }
    } catch (err) {
      console.error(`Cron failed for ${payment.id}:`, err);
      // Ошибка Adesk/сети: инкрементим попытку и через 5 дней ORPHANED, чтобы
      // навсегда-падающий платёж не крутился в очереди без следа.
      if (payment.paymentMethod === 'cash') {
        await bumpAttemptAndMaybeOrphan(payment).catch(() => {});
      }
      results.push({ paymentId: payment.id, method: payment.paymentMethod, result: 'error' });
    }
  }

  // Уведомление в Telegram о «зависших» >24 часов платежах (дайджест раз в день).
  // Шлём только если этот запуск — первый после полуночи (чтобы не спамить
  // каждый час). Маркер — поле lastStaleNotifyAt на одном из этих платежей
  // не пригодится, поэтому просто шлём при час = 7 (утренний запуск крона).
  const hour = new Date().getHours();
  if (hour === 7) {
    const cutoff = new Date(Date.now() - STALE_NOTIFY_HOURS * 3600 * 1000);
    const stale = await prisma.payment.findMany({
      where: {
        status: 'PENDING_RETRO',
        createdAt: { lt: cutoff },
      },
      include: { unit: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (stale.length > 0) {
      const lines = stale.map((p) =>
        `• ${p.unit.name} / ${Number(p.amount).toLocaleString('ru-RU')} ₽ / ${p.date.toISOString().split('T')[0]} / ${p.cardNote || '—'}`,
      );
      const text = [
        `⚠️ ${stale.length} платеж${stale.length === 1 ? '' : 'а'} висит >24ч без матча в Adesk:`,
        ...lines,
        '',
        'Открой мини-аппу → вкладка «Проблемы» чтобы разобраться.',
      ].join('\n');
      sendToGroup(text).catch(() => {});
    }
  }

  return Response.json({
    ok: true,
    total: pendingPayments.length,
    results,
  });
}
