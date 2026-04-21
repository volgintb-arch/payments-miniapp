// GET /api/cron/retro
// Крон-обработчик всех незавершённых платежей:
//   - card + PENDING_RETRO  → ретро-матч с банковской операцией
//   - cash + PENDING_RETRO  → повторная попытка создать транзакцию в Adesk
// Через 5 дней без успеха → ORPHANED.

import { prisma } from '@/lib/db';
import { processRetroMatch } from '@/lib/retro-match';
import { adesk } from '@/lib/adesk/client';

const CRON_SECRET = process.env.CRON_SECRET || '';

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

  return Response.json({
    ok: true,
    total: pendingPayments.length,
    results,
  });
}
