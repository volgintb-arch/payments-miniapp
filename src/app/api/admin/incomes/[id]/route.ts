// POST   /api/admin/incomes/[id] — повторно пробуем создать приход в Adesk
// DELETE /api/admin/incomes/[id] — удаляем запись прихода
// Доступ: Bearer CRON_SECRET или ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { getAuthUser } from '@/lib/api-helpers';

const CRON_SECRET = process.env.CRON_SECRET || '';

function isAuthorized(request: NextRequest): boolean {
  const auth = request.headers.get('authorization');
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const user = getAuthUser(request);
  return user?.role === 'ADMIN';
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const income = await prisma.cashIncome.findUnique({ where: { id } });
  if (!income) return Response.json({ error: 'Not found' }, { status: 404 });
  if (income.status === 'MATCHED') {
    return Response.json({ error: 'Already matched' }, { status: 400 });
  }

  try {
    const res = await adesk.createTransaction({
      amount: Number(income.amount),
      date: income.date.toISOString().split('T')[0],
      type: 'income',
      bankAccountId: income.adeskSafeId,
      categoryId: income.adeskCategoryId,
      projectId: income.adeskProjectId ?? undefined,
      contractorId: income.adeskContractorId ?? undefined,
      description: income.description ?? undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resAny = res as any;
    const txId = resAny.transaction?.id || resAny.transactions?.[0]?.id || resAny.id;
    if (!txId) {
      await prisma.cashIncome.update({ where: { id }, data: { status: 'FAILED' } });
      return Response.json(
        { error: 'Adesk did not return transaction id', response: res },
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
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
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
