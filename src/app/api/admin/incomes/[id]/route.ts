// POST   /api/admin/incomes/[id] — повторно пробуем создать приход в Adesk
// DELETE /api/admin/incomes/[id] — удаляем запись прихода
// Доступ: Bearer CRON_SECRET или ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { createTransactionIdempotent } from '@/lib/adesk/idempotent';
import { denyUnlessRole } from '@/lib/api-helpers';


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await denyUnlessRole(request, ['ADMIN']);
  if (denied) return denied;

  const { id } = await params;
  const income = await prisma.cashIncome.findUnique({ where: { id } });
  if (!income) return Response.json({ error: 'Not found' }, { status: 404 });
  if (income.status === 'MATCHED') {
    return Response.json({ error: 'Already matched' }, { status: 400 });
  }

  try {
    // Идемпотентно: повтор после таймаута (когда приход в Adesk фактически
    // создался) найдёт существующую транзакцию, а не задвоит приход.
    const { txId } = await createTransactionIdempotent({
      amount: Number(income.amount),
      date: income.date.toISOString().split('T')[0],
      type: 'income',
      bankAccountId: income.adeskSafeId,
      categoryId: income.adeskCategoryId,
      projectId: income.adeskProjectId ?? undefined,
      contractorId: income.adeskContractorId ?? undefined,
      description: income.description ?? undefined,
    });
    if (!txId) {
      await prisma.cashIncome.update({ where: { id }, data: { status: 'FAILED' } });
      return Response.json(
        { error: 'Adesk did not return transaction id' },
        { status: 502 },
      );
    }
    await prisma.cashIncome.update({
      where: { id },
      data: { status: 'MATCHED', adeskTransactionId: txId, matchedAt: new Date() },
    });
    return Response.json({ ok: true, transactionId: txId });
  } catch (err) {
    await prisma.cashIncome.update({ where: { id }, data: { status: 'FAILED' } });
    return Response.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 502 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await denyUnlessRole(request, ['ADMIN']);
  if (denied) return denied;
  const { id } = await params;
  const income = await prisma.cashIncome.findUnique({ where: { id } });
  if (!income) return Response.json({ error: 'Not found' }, { status: 404 });
  if (income.status === 'MATCHED') {
    return Response.json(
      { error: 'Нельзя удалить приход, уже привязанный к транзакции Adesk' },
      { status: 400 },
    );
  }
  await prisma.cashIncome.delete({ where: { id } });
  return Response.json({ ok: true });
}
