// GET /api/cron/retro
// Крон-обработчик всех незавершённых платежей:
//   - card + PENDING_RETRO  → ретро-матч с банковской операцией
//   - cash + PENDING_RETRO  → повторная попытка создать транзакцию в Adesk
// Через 5 дней без успеха → ORPHANED.

import { prisma } from '@/lib/db';
import { processRetroMatch } from '@/lib/retro-match';
import { adesk } from '@/lib/adesk/client';
import { sendToGroup } from '@/lib/telegram';

const CRON_SECRET = process.env.CRON_SECRET || '';
const STALE_NOTIFY_HOURS = 24;

export async function GET(request: Request) {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const pendingPayments = await prisma.payment.findMany({
    where: { status: 'PENDING_RETRO' },
    orderBy: { createdAt: 'asc' },
  });

  const results: { paymentId: string; method: string; result: string }[] = [];

  for (const payment of pendingPayments) {
    try {
      if (payment.paymentMethod === 'cash') {
        if (!payment.adeskSafeId) {
          results.push({ paymentId: payment.id, method: 'cash', result: 'no_safe' });
          continue;
        }
        const res = await adesk.createTransaction({
          amount: Number(payment.amount),
          date: payment.date.toISOString().split('T')[0],
          type: 'outcome',
          bankAccountId: payment.adeskSafeId,
          categoryId: payment.adeskCategoryId,
          projectId: payment.adeskProjectId ?? undefined,
          contractorId: payment.adeskContractorId ?? undefined,
          description: payment.description ?? undefined,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txId = (res as any).transaction?.id || (res as any).id;
        if (txId) {
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
          results.push({ paymentId: payment.id, method: 'cash', result: 'created' });
        } else {
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              retroAttempts: { increment: 1 },
              lastRetroAttemptAt: new Date(),
            },
          });
          const daysSinceCreation =
            (Date.now() - payment.createdAt.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceCreation >= 5) {
            await prisma.payment.update({
              where: { id: payment.id },
              data: { status: 'ORPHANED' },
            });
          }
          results.push({ paymentId: payment.id, method: 'cash', result: 'no_id' });
        }
      } else {
        const result = await processRetroMatch(payment.id);
        results.push({ paymentId: payment.id, method: 'card', result: result.status });
      }
    } catch (err) {
      console.error(`Cron failed for ${payment.id}:`, err);
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
