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
    select: { id: true, status: true, adeskConfirmedTransactionId: true, paymentMethod: true },
  });
  if (!payment) return Response.json({ error: 'Payment not found' }, { status: 404 });

  if (payment.status !== 'MATCHED' || !payment.adeskConfirmedTransactionId) {
    return Response.json(
      { error: `Payment is not MATCHED (status=${payment.status}), nothing to unmatch` },
      { status: 409 },
    );
  }

  // Наличные привязываются через СОЗДАНИЕ транзакции в Adesk (крон/POST), а не
  // через матч с существующей. Unmatch наличного вернул бы платёж в очередь, и
  // следующий крон создал бы ВТОРУЮ транзакцию на ту же сумму — дубль расхода.
  // Компенсации (удаления созданной tx) у нас нет, поэтому запрещаем.
  if (payment.paymentMethod === 'cash') {
    return Response.json(
      {
        error:
          'Наличный платёж отвязать нельзя: он создал транзакцию в Adesk, и ' +
          'повторная обработка задвоила бы расход. Правьте операцию в Adesk вручную.',
      },
      { status: 409 },
    );
  }

  const releasedTxId = payment.adeskConfirmedTransactionId;

  // Ставим NEEDS_REVIEW, а не PENDING_RETRO: иначе крон тут же снова находит
  // эту же tx единственным кандидатом по сумме/карте и восстанавливает ту же
  // (ошибочную) привязку до того, как админ привяжет правильный платёж.
  // Освобождённую tx подберёт правильный PENDING_RETRO-платёж; этот — ждёт
  // ручного manual-match.
  await prisma.payment.update({
    where: { id },
    data: {
      status: 'NEEDS_REVIEW',
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
