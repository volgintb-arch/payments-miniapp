// src/lib/retro-match.ts
// Ретро-матчинг: ищет фактическую операцию в Adesk, совпадающую с платежом.
//
// Алгоритм:
//   1. Получаем банковские счета юнитов платежа (и юнитов из сплитов, если есть)
//   2. Запрашиваем completed-операции из Adesk за окно ±2 дня от даты платежа
//   3. Фильтруем по совпадению суммы (с точностью до копейки), исключая
//      уже привязанные к другим платежам транзакции.
//   4. Если 1 кандидат — MATCHED, проставляем статью (или parts[] для сплит-платежей)
//   5. Если >1 — NEEDS_REVIEW
//   6. Если 0 — оставляем PENDING_RETRO (крон повторит)

import { prisma } from './db';
import { adesk } from './adesk/client';
import type { AdeskTransaction } from './adesk/types';

type MatchResult =
  | { status: 'matched'; transactionId: number; existingDescription?: string }
  | { status: 'needs_review'; candidates: number[] }
  | { status: 'not_found' };

export async function findMatchingTransaction(
  paymentId: string,
): Promise<MatchResult> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      unit: { include: { bankAccounts: true } },
      splits: true,
    },
  });

  if (!payment) throw new Error(`Payment ${paymentId} not found`);

  // Ищем по всем bank-accounts юнитов, к которым у пользователя-автора есть доступ.
  // Причина: карта может физически принадлежать другому юнит-юрлицу, чем
  // бухгалтерский юнит расхода. Если по сумме+дате единственный кандидат —
  // matched; если несколько — needs_review.
  const userUnits = await prisma.userUnit.findMany({
    where: { userId: payment.userId },
    select: { unitId: true },
  });
  const unitIds = new Set<number>(userUnits.map((u) => u.unitId));
  unitIds.add(payment.unitId);
  for (const s of payment.splits) unitIds.add(s.unitId);

  const bankAccounts = await prisma.unitBankAccount.findMany({
    where: { unitId: { in: Array.from(unitIds) } },
    select: { adeskBankAccountId: true },
  });
  const bankAccountIds = Array.from(
    new Set(bankAccounts.map((ba) => ba.adeskBankAccountId)),
  );

  if (bankAccountIds.length === 0) {
    return { status: 'not_found' };
  }

  const paymentDate = new Date(payment.date);
  const rangeStart = new Date(paymentDate);
  rangeStart.setDate(rangeStart.getDate() - 2);
  const rangeEnd = new Date(paymentDate);
  rangeEnd.setDate(rangeEnd.getDate() + 2);

  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const allTxs: AdeskTransaction[] = [];

  for (const bankAccountId of bankAccountIds) {
    const res = await adesk.listTransactions({
      status: 'completed',
      type: 'outcome',
      bankAccount: bankAccountId,
      rangeStart: fmt(rangeStart),
      rangeEnd: fmt(rangeEnd),
    });
    if (res.transactions) {
      allTxs.push(...res.transactions);
    }
  }

  const uniqueTxs = new Map<number, AdeskTransaction>();
  for (const tx of allTxs) {
    uniqueTxs.set(tx.id, tx);
  }

  // Фильтр "Терминал:" убран — банки присылают разный формат описаний.
  // Bank-accounts юнита и так картовые (наличные идут через safes).
  const paymentAmount = Number(payment.amount);
  const candidates: number[] = [];

  for (const tx of uniqueTxs.values()) {
    const txAmount = Math.abs(Number(tx.amount));
    if (Math.abs(txAmount - paymentAmount) < 0.01) {
      candidates.push(tx.id);
    }
  }

  // Отсекаем уже занятые транзакции
  if (candidates.length > 0) {
    const taken = await prisma.payment.findMany({
      where: {
        adeskConfirmedTransactionId: { in: candidates },
        id: { not: paymentId },
      },
      select: { adeskConfirmedTransactionId: true },
    });
    const takenSet = new Set(
      taken.map((t) => t.adeskConfirmedTransactionId).filter(Boolean) as number[],
    );
    const available = candidates.filter((id) => !takenSet.has(id));
    candidates.length = 0;
    candidates.push(...available);
  }

  if (candidates.length === 1) {
    const matchedTx = uniqueTxs.get(candidates[0]);
    return {
      status: 'matched',
      transactionId: candidates[0],
      existingDescription: matchedTx?.description || '',
    };
  }

  if (candidates.length > 1) {
    return { status: 'needs_review', candidates };
  }

  return { status: 'not_found' };
}

export async function processRetroMatch(paymentId: string): Promise<MatchResult> {
  const result = await findMatchingTransaction(paymentId);

  if (result.status === 'matched') {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { splits: true },
    });

    if (payment) {
      const updates: Parameters<typeof adesk.updateTransaction>[1] = {};

      if (payment.splits.length > 0) {
        // Разбивка — отправляем parts[]
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

      // Описание: миниап-описание перед банковским
      const descParts = [payment.description, result.existingDescription].filter(Boolean);
      if (descParts.length > 0) {
        updates.description = descParts.join(' | ');
      }

      await adesk.updateTransaction(result.transactionId, updates);

      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'MATCHED',
          adeskConfirmedTransactionId: result.transactionId,
          matchedAt: new Date(),
          retroAttempts: { increment: 1 },
          lastRetroAttemptAt: new Date(),
        },
      });
    }
  } else if (result.status === 'needs_review') {
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'NEEDS_REVIEW',
        retroAttempts: { increment: 1 },
        lastRetroAttemptAt: new Date(),
      },
    });

    await prisma.matchConflict.create({
      data: {
        id: globalThis.crypto.randomUUID(),
        paymentId,
        candidateTransactionIds: result.candidates,
        candidatePaymentIds: [],
      },
    });
  } else {
    const payment = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        retroAttempts: { increment: 1 },
        lastRetroAttemptAt: new Date(),
      },
    });

    const daysSinceCreation =
      (Date.now() - payment.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreation >= 5) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'ORPHANED' },
      });
    }
  }

  return result;
}
