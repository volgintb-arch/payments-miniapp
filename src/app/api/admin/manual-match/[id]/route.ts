// POST /api/admin/manual-match/:paymentId
// Body: { transactionId?: number, transactionIds?: number[] }
// Ручная привязка платежа к одной (или нескольким — если банк разделил чек)
// Adesk-операциям, когда авто-матч не сработал.
// Доступ: Bearer CRON_SECRET или JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { denyUnlessRole, isUniqueViolation } from '@/lib/api-helpers';


export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = await denyUnlessRole(request, ['ADMIN']);
  if (denied) return denied;

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

  // Модель хранит ровно одну привязку (adeskConfirmedTransactionId @unique).
  // Привязка к нескольким транзакциям раньше: (а) записывала в БД только
  // первую — остальные оставались «ничьими» и попадали в двойной учёт;
  // (б) для сплит-платежа слала parts на полную сумму в КАЖДУЮ tx; (в) при
  // сбое на второй tx откатывала БД, но первая оставалась размеченной в Adesk.
  // Пока нет модели связи payment↔много-tx — принимаем только одну.
  if (txIds.length > 1) {
    return Response.json(
      {
        error:
          'Привязка к нескольким транзакциям временно недоступна (приводила к ' +
          'двойному учёту). Привяжите платёж к одной операции.',
      },
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
  // Описание в Adesk сохраняем «X | original», но без дублирования префикса:
  // если первая часть уже совпадает с payment.description — оставляем как есть.
  // updateTransaction в Adesk без description вообще оставит существующее.
  // Здесь мы намеренно НЕ фетчим текущее описание tx, чтобы не делать лишний
  // запрос; вместо этого: если payment.description пустой — не трогаем поле.

  // CAS-claim: атомарно переводим в MATCHED ДО вызова Adesk.
  // Если параллельный rematch / другой админ уже сматчил — выходим без
  // повторного Adesk-апдейта, иначе описание получит дубль префикса.
  let claim;
  try {
    claim = await prisma.payment.updateMany({
      where: {
        id,
        status: { in: ['PENDING_RETRO', 'NEEDS_REVIEW', 'ORPHANED'] },
      },
      data: {
        status: 'MATCHED',
        adeskConfirmedTransactionId: txIds[0],
        matchedAt: new Date(),
        retroAttempts: { increment: 1 },
        lastRetroAttemptAt: new Date(),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Ту же транзакцию забрал другой платёж между takenByOthers и claim.
      return Response.json(
        { error: 'Some transactions already bound to other payments' },
        { status: 409 },
      );
    }
    throw err;
  }
  if (claim.count === 0) {
    return Response.json(
      { error: 'Payment already matched by another process', paymentId: id },
      { status: 409 },
    );
  }

  try {
    for (const txId of txIds) {
      await adesk.updateTransaction(txId, updates);
    }
  } catch (err) {
    await prisma.payment.updateMany({
      where: { id, status: 'MATCHED', adeskConfirmedTransactionId: txIds[0] },
      data: { status: 'PENDING_RETRO', adeskConfirmedTransactionId: null, matchedAt: null },
    });
    console.error(`[manual-match] Adesk update failed for ${id}, status rolled back:`, err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Adesk update failed' },
      { status: 502 },
    );
  }

  // Снимаем висящие записи о конфликтах для этого платежа.
  await prisma.matchConflict.deleteMany({ where: { paymentId: id } });

  return Response.json({
    ok: true,
    paymentId: id,
    transactionIds: txIds,
    amount: Number(payment.amount),
    splits: payment.splits.length,
  });
}
