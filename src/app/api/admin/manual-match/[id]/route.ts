// POST /api/admin/manual-match/:paymentId
// Body: { transactionId: number }
// Ручная привязка платежа к конкретной Adesk-операции, когда авто-матч
// не сработал (расхождение копеек, банк слил операции, и т.п.).
// Доступ — по Bearer CRON_SECRET.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';

const CRON_SECRET = process.env.CRON_SECRET || '';

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (CRON_SECRET) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { id } = await ctx.params;
  const body = await request.json().catch(() => null);
  const transactionId = Number(body?.transactionId);
  if (!transactionId) {
    return Response.json({ error: 'transactionId is required' }, { status: 400 });
  }

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { splits: true },
  });
  if (!payment) return Response.json({ error: 'Payment not found' }, { status: 404 });

  const taken = await prisma.payment.findFirst({
    where: { adeskConfirmedTransactionId: transactionId, id: { not: id } },
    select: { id: true },
  });
  if (taken) {
    return Response.json(
      { error: `Transaction ${transactionId} already bound to payment ${taken.id}` },
      { status: 409 },
    );
  }

  const updates: Parameters<typeof adesk.updateTransaction>[1] = {};
  if (payment.splits.length > 0) {
    updates.parts = payment.splits.map((s) => ({
      amount: Number(s.amount),
      categoryId: s.adeskCategoryId,
      projectId: s.adeskProjectId ?? undefined,
      contractorId: s.adeskContractorId ?? undefined,
      description: s.description ?? undefined,
    }));
  } else {
    updates.categoryId = payment.adeskCategoryId;
    if (payment.adeskContractorId) updates.contractorId = payment.adeskContractorId;
    if (payment.adeskProjectId) updates.projectId = payment.adeskProjectId;
  }
  if (payment.description) updates.description = payment.description;

  await adesk.updateTransaction(transactionId, updates);

  await prisma.payment.update({
    where: { id },
    data: {
      status: 'MATCHED',
      adeskConfirmedTransactionId: transactionId,
      matchedAt: new Date(),
      retroAttempts: { increment: 1 },
      lastRetroAttemptAt: new Date(),
    },
  });

  return Response.json({
    ok: true,
    paymentId: id,
    transactionId,
    amount: Number(payment.amount),
    splits: payment.splits.length,
  });
}
