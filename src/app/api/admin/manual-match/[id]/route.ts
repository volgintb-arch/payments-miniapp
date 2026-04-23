// POST /api/admin/manual-match/:paymentId
// Body: { transactionId?: number, transactionIds?: number[] }
// Ручная привязка платежа к одной (или нескольким — если банк разделил чек)
// Adesk-операциям, когда авто-матч не сработал.
// Доступ: Bearer CRON_SECRET или JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { getAuthUser } from '@/lib/api-helpers';

const CRON_SECRET = process.env.CRON_SECRET || '';

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const body = await request.json().catch(() => null);

  const txIds: number[] = Array.isArray(body?.transactionIds)
    ? body.transactionIds.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
    : body?.transactionId
      ? [Number(body.transactionId)]
      : [];

  if (txIds.length === 0) {
    return Response.json(
      { error: 'transactionId or transactionIds[] is required' },
      { status: 400 },
    );
  }

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { splits: true },
  });
  if (!payment) return Response.json({ error: 'Payment not found' }, { status: 404 });

  const takenByOthers = await prisma.payment.findMany({
    where: { adeskConfirmedTransactionId: { in: txIds }, id: { not: id } },
    select: { id: true, adeskConfirmedTransactionId: true },
  });
  if (takenByOthers.length > 0) {
    return Response.json(
      {
        error: 'Some transactions already bound to other payments',
        conflicts: takenByOthers,
      },
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

  for (const txId of txIds) {
    await adesk.updateTransaction(txId, updates);
  }

  await prisma.payment.update({
    where: { id },
    data: {
      status: 'MATCHED',
      adeskConfirmedTransactionId: txIds[0],
      matchedAt: new Date(),
      retroAttempts: { increment: 1 },
      lastRetroAttemptAt: new Date(),
    },
  });

  return Response.json({
    ok: true,
    paymentId: id,
    transactionIds: txIds,
    amount: Number(payment.amount),
    splits: payment.splits.length,
  });
}

function isAuthorized(request: NextRequest): boolean {
  const auth = request.headers.get('authorization');
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const user = getAuthUser(request);
  return user?.role === 'ADMIN';
}
