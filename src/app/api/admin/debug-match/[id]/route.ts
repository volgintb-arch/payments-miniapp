// GET /api/admin/debug-match/:paymentId?window=7
// Диагностика: показывает платёж + все outcome-операции из Adesk за расширенное окно
// по bank-accounts юнита (и юнитов сплитов), чтобы понять почему не совпало.
// Доступ — по Bearer CRON_SECRET.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { extractCardSuffix, getMatcherBankAccountIds } from '@/lib/retro-match';
import { denyUnlessCronSecret } from '@/lib/api-helpers';

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = denyUnlessCronSecret(request);
  if (denied) return denied;

  const { id } = await ctx.params;
  // Ограничиваем окно: без верхней границы большое значение раздувает запросы
  // к Adesk по каждому счёту (potential DoS), NaN — отбрасываем в дефолт.
  const rawWindow = Number(request.nextUrl.searchParams.get('window'));
  const windowDays = Number.isFinite(rawWindow)
    ? Math.min(30, Math.max(1, Math.trunc(rawWindow)))
    : 7;

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { unit: true, splits: true },
  });
  if (!payment) return Response.json({ error: 'Payment not found' }, { status: 404 });

  // Подбираем bank accounts по той же логике что и матчер: если у платежа
  // есть 4-значный cardSuffix — берём все счета Adesk (защита через card-mask);
  // если cardNote-заметка — fallback к UnitBankAccount юнита.
  const cardSuffix = extractCardSuffix(payment.cardNote);
  const matcherBankAccountIds = await getMatcherBankAccountIds(payment, cardSuffix);
  const bankAccounts = matcherBankAccountIds.map((adeskBankAccountId) => ({ adeskBankAccountId }));

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
    unitIds: [payment.unitId, ...payment.splits.map((s) => s.unitId)],
    cardSuffix,
    bankAccountIds: bankAccounts.map((ba) => ba.adeskBankAccountId),
    window: { start: fmt(rangeStart), end: fmt(rangeEnd), days: windowDays },
    closeCandidates,
    byAccount,
  });
}
