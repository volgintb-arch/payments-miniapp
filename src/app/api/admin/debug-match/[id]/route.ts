// GET /api/admin/debug-match/:paymentId?window=7
// Диагностика: показывает платёж + все outcome-операции из Adesk за расширенное окно
// по bank-accounts юнита (и юнитов сплитов), чтобы понять почему не совпало.
// Доступ — по Bearer CRON_SECRET.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';

const CRON_SECRET = process.env.CRON_SECRET || '';

export async function GET(
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
  const windowDays = Number(request.nextUrl.searchParams.get('window') || 7);

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { unit: true, splits: true },
  });
  if (!payment) return Response.json({ error: 'Payment not found' }, { status: 404 });

  const unitIds = new Set<number>([payment.unitId]);
  for (const s of payment.splits) unitIds.add(s.unitId);

  const bankAccounts = await prisma.unitBankAccount.findMany({
    where: { unitId: { in: Array.from(unitIds) } },
  });

  const paymentDate = new Date(payment.date);
  const rangeStart = new Date(paymentDate);
  rangeStart.setDate(rangeStart.getDate() - windowDays);
  const rangeEnd = new Date(paymentDate);
  rangeEnd.setDate(rangeEnd.getDate() + windowDays);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const byAccount: Record<string, unknown> = {};
  const targetAmount = Number(payment.amount);
  const closeCandidates: Array<{ bankAccountId: number; tx: unknown }> = [];

  for (const ba of bankAccounts) {
    const res = await adesk.listTransactions({
      status: 'completed',
      type: 'outcome',
      bankAccount: ba.adeskBankAccountId,
      rangeStart: fmt(rangeStart),
      rangeEnd: fmt(rangeEnd),
    });
    const txs = res.transactions || [];
    byAccount[String(ba.adeskBankAccountId)] = {
      count: txs.length,
      txs: txs.map((t) => ({
        id: t.id,
        amount: Number(t.amount),
        date: t.date,
        desc: t.description?.slice(0, 80),
      })),
    };
    for (const t of txs) {
      const diff = Math.abs(Math.abs(Number(t.amount)) - targetAmount);
      if (diff < 10) {
        closeCandidates.push({
          bankAccountId: ba.adeskBankAccountId,
          tx: { id: t.id, amount: Number(t.amount), date: t.date, desc: t.description, diff },
        });
      }
    }
  }

  return Response.json({
    payment: {
      id: payment.id,
      unit: payment.unit.name,
      amount: targetAmount,
      date: fmt(paymentDate),
      paymentMethod: payment.paymentMethod,
      status: payment.status,
      retroAttempts: payment.retroAttempts,
    },
    unitIds: Array.from(unitIds),
    bankAccountIds: bankAccounts.map((ba) => ba.adeskBankAccountId),
    window: { start: fmt(rangeStart), end: fmt(rangeEnd), days: windowDays },
    closeCandidates,
    byAccount,
  });
}
