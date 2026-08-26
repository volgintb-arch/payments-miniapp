// POST /api/admin/payments/:id/unmatch
// Отвязывает Payment от Adesk-транзакции, на которую он сейчас ссылается.
// Используется когда транзакция была привязана ошибочно (старый race condition
// до фикса CAS, либо дубль платежа) и нужно освободить tx, чтобы её мог
// «подобрать» правильный платёж.
//
// Что делает:
//   - status: MATCHED → PENDING_RETRO
//   - adeskConfirmedTransactionId → null
//   - matchedAt → null
//   - matchConflict-записи остаются как были.
//
// Что НЕ делает:
//   - не трогает описание/категорию/проект в Adesk (это историческое состояние,
//     ручной откат при необходимости).
//   - не удаляет сам Payment. Если платёж — дубль и его надо снести, отдельно
//     вызвать DELETE /api/admin/pending/:id.
//
// Доступ: Bearer CRON_SECRET или JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/api-helpers';

const CRON_SECRET = process.env.CRON_SECRET || '';

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthorized(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;

  const payment = await prisma.payment.findUnique({
    where: { id },
    select: { id: true, status: true, adeskConfirmedTransactionId: true },
  });
  if (!payment) return Response.json({ error: 'Payment not found' }, { status: 404 });

  if (payment.status !== 'MATCHED' || !payment.adeskConfirmedTransactionId) {
    return Response.json(
      { error: `Payment is not MATCHED (status=${payment.status}), nothing to unmatch` },
      { status: 409 },
    );
  }

  const releasedTxId = payment.adeskConfirmedTransactionId;

  await prisma.payment.update({
    where: { id },
    data: {
      status: 'PENDING_RETRO',
      adeskConfirmedTransactionId: null,
      matchedAt: null,
    },
  });

  return Response.json({
    ok: true,
    paymentId: id,
    releasedTxId,
  });
}

async function isAuthorized(request: NextRequest): Promise<boolean> {
  const auth = request.headers.get('authorization');
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const user = await getAuthUser(request);
  return user?.role === 'ADMIN';
}
