// src/lib/retro-match.ts
// Ретро-матчинг: ищет фактическую операцию в Adesk, совпадающую с платежом.
//
// Алгоритм:
//   1. Получаем банковские счета юнита из БД
//   2. Запрашиваем completed-операции из Adesk за окно ±2 дня от даты платежа
//   3. Фильтруем по совпадению суммы (с точностью до копейки)
//   4. Если 1 кандидат — MATCHED, проставляем статью
//   5. Если >1 — NEEDS_REVIEW
//   6. Если 0 — оставляем PENDING_RETRO (cron повторит)

import { prisma } from './db';
import { adesk } from './adesk/client';
import type { AdeskTransaction } from './adesk/types';

type MatchResult =
  | { status: 'matched'; transactionId: number; existingDescription?: string }
  | { status: 'needs_review'; candidates: number[] }
  | { status: 'not_found' };

/**
 * Ищет фактическую операцию в Adesk для данного платежа.
 */
export async function findMatchingTransaction(
  paymentId: string,
): Promise<MatchResult> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { unit: { include: { bankAccounts: true } } },
  });

  if (!payment) throw new Error(`Payment ${paymentId} not found`);

  const bankAccountIds = payment.unit.bankAccounts.map(
    (ba) => ba.adeskBankAccountId,
  );

  if (bankAccountIds.length === 0) {
    return { status: 'not_found' };
  }

  // Окно поиска: ±2 дня от даты платежа
  const paymentDate = new Date(payment.date);
  const rangeStart = new Date(paymentDate);
  rangeStart.setDate(rangeStart.getDate() - 2);
  const rangeEnd = new Date(paymentDate);
  rangeEnd.setDate(rangeEnd.getDate() + 2);

  const fmt = (d: Date) => d.toISOString().split('T')[0];

  // Запрашиваем транзакции по каждому счёту юнита
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

  // Дедупликация по id
  const uniqueTxs = new Map<number, AdeskTransaction>();
  for (const tx of allTxs) {
    uniqueTxs.set(tx.id, tx);
  }

  // Сравниваем суммы (Adesk amount — строка, payment.amount — Decimal)
  const paymentAmount = Number(payment.amount);
  const candidates: number[] = [];

  for (const tx of uniqueTxs.values()) {
    const txAmount = Math.abs(Number(tx.amount));
    if (Math.abs(txAmount - paymentAmount) < 0.01) {
      candidates.push(tx.id);
    }
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

/**
 * Выполняет ретро-матчинг и обновляет платёж + Adesk.
 */
export async function processRetroMatch(paymentId: string): Promise<MatchResult> {
  const result = await findMatchingTransaction(paymentId);

  if (result.status === 'matched') {
    // Проставляем статью и контрагента в Adesk
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (payment) {
      const updates: Record<string, unknown> = {
        categoryId: payment.adeskCategoryId,
      };
      if (payment.adeskContractorId) {
        updates.contractorId = payment.adeskContractorId;
      }
      if (payment.adeskProjectId) {
        updates.projectId = payment.adeskProjectId;
      }
      // Дописываем описание из мини-аппа перед существующим описанием из банка
      const parts = [payment.description, result.existingDescription].filter(Boolean);
      if (parts.length > 0) {
        updates.description = parts.join(' | ');
      }

      await adesk.updateTransaction(result.transactionId, updates as {
        categoryId?: number;
        contractorId?: number;
        projectId?: number;
        description?: string;
      });

      // Обновляем платёж в БД
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

    // Создаём конфликт
    await prisma.matchConflict.create({
      data: {
        id: globalThis.crypto.randomUUID(),
        paymentId,
        candidateTransactionIds: result.candidates,
        candidatePaymentIds: [],
      },
    });
  } else {
    // not_found — увеличиваем счётчик попыток
    const payment = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        retroAttempts: { increment: 1 },
        lastRetroAttemptAt: new Date(),
      },
    });

    // Если прошло 5 дней — ORPHANED
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
