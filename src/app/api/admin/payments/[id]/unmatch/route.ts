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
import { denyUnlessRole } from '@/lib/api-helpers';


export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = await denyUnlessRole(request, ['ADMIN']);
  if (denied) return denied;

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
