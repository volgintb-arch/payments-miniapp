// GET /api/admin/pending
// Возвращает все «висящие» платежи (PENDING_RETRO / NEEDS_REVIEW / ORPHANED)
// с близкими кандидатами из Adesk (окно ±7 дней, ±10₽).
//
// Доступ: Bearer CRON_SECRET или JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { getAuthUser } from '@/lib/api-helpers';

const CRON_SECRET = process.env.CRON_SECRET || '';
const WINDOW_DAYS = 7;
const AMOUNT_TOLERANCE = 10;

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const payments = await prisma.payment.findMany({
    where: {
      status: { in: ['PENDING_RETRO', 'NEEDS_REVIEW', 'ORPHANED'] },
      paymentMethod: 'card',
    },
    include: {
      user: { select: { firstName: true, lastName: true } },
      unit: { select: { name: true } },
      splits: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const out = [];
  for (const p of payments) {
    const unitIds = new Set<number>([p.unitId]);
    for (const s of p.splits) unitIds.add(s.unitId);
    const userUnits = await prisma.userUnit.findMany({
      where: { userId: p.userId },
      select: { unitId: true },
    });
    for (const uu of userUnits) unitIds.add(uu.unitId);

    const bankAccounts = await prisma.unitBankAccount.findMany({
      where: { unitId: { in: Array.from(unitIds) } },
      select: { adeskBankAccountId: true },
    });
    const bankAccountIds = Array.from(
      new Set(bankAccounts.map((ba) => ba.adeskBankAccountId)),
    );

    const paymentDate = new Date(p.date);
    const rangeStart = new Date(paymentDate);
    rangeStart.setDate(rangeStart.getDate() - WINDOW_DAYS);
    const rangeEnd = new Date(paymentDate);
    rangeEnd.setDate(rangeEnd.getDate() + WINDOW_DAYS);
    const fmt = (d: Date) => d.toISOString().split('T')[0];

    const target = Number(p.amount);
    const candidates: Array<{
      txId: number;
      amount: number;
      date: string;
      diff: number;
      description: string;
      bankAccountId: number;
    }> = [];

    for (const baId of bankAccountIds) {
      const res = await adesk.listTransactions({
        status: 'completed',
        type: 'outcome',
        bankAccount: baId,
        rangeStart: fmt(rangeStart),
        rangeEnd: fmt(rangeEnd),
      });
      const txs = res.transactions || [];
      for (const t of txs) {
        const amt = Math.abs(Number(t.amount));
        const diff = Math.abs(amt - target);
        if (diff <= AMOUNT_TOLERANCE) {
          candidates.push({
            txId: t.id,
            amount: amt,
            date: t.date,
            diff,
            description: t.description || '',
            bankAccountId: baId,
          });
        }
      }
    }

    const seen = new Set<number>();
    const uniq = candidates.filter((c) => {
      if (seen.has(c.txId)) return false;
      seen.add(c.txId);
      return true;
    });
    uniq.sort((a, b) => a.diff - b.diff);

    // Помечаем уже занятые другими платежами
    const takenIds = uniq.map((c) => c.txId);
    const takenBy = takenIds.length
      ? await prisma.payment.findMany({
          where: { adeskConfirmedTransactionId: { in: takenIds }, id: { not: p.id } },
          select: { id: true, adeskConfirmedTransactionId: true },
        })
      : [];
    const takenMap = new Map<number, string>();
    for (const t of takenBy) {
      if (t.adeskConfirmedTransactionId) takenMap.set(t.adeskConfirmedTransactionId, t.id);
    }

    out.push({
      id: p.id,
      amount: target,
      date: fmt(paymentDate),
      description: p.description,
      cardNote: p.cardNote,
      unitName: p.unit.name,
      userName: `${p.user.firstName} ${p.user.lastName ?? ''}`.trim(),
      status: p.status,
      retroAttempts: p.retroAttempts,
      createdAt: p.createdAt,
      hasSplits: p.splits.length > 0,
      candidates: uniq.slice(0, 20).map((c) => ({
        ...c,
        takenByPaymentId: takenMap.get(c.txId) || null,
      })),
    });
  }

  return Response.json({ payments: out });
}

function isAuthorized(request: NextRequest): boolean {
  const auth = request.headers.get('authorization');
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const user = getAuthUser(request);
  return user?.role === 'ADMIN';
}
