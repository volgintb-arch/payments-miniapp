// src/lib/retro-match.ts
// Ретро-матчинг: ищет фактическую операцию (или пару операций) в Adesk,
// совпадающую с платежом.
//
// Алгоритм:
//   1. Получаем банковские счета юнитов платежа (и юнитов из сплитов, если есть)
//      + всех юнитов, к которым у пользователя есть доступ.
//   2. Запрашиваем completed-операции из Adesk за окно ±4 дня от даты платежа
//      (банк иногда посчитает операцию на 2-3 дня позже).
//   3. Первый проход: точное совпадение суммы (±0.01).
//   4. Если пусто — второй проход: пара операций того же дня с тем же
//      description-префиксом (банк иногда разбивает чек на 2 операции —
//      например, 628.42 + 9.09 = 637.51 в KUPER2). Привязываем обе к одному
//      платежу.
//   5. Исключаем уже привязанные к другим платежам транзакции.
//   6. 1 кандидат/пара → MATCHED, >1 → NEEDS_REVIEW, 0 → PENDING_RETRO.

import { prisma } from './db';
import { adesk } from './adesk/client';
import type { AdeskTransaction } from './adesk/types';

export type MatchResult =
  | { status: 'matched'; transactionIds: number[]; existingDescription?: string }
  | { status: 'needs_review'; candidates: number[][] }
  | { status: 'not_found' };

const AMOUNT_EPSILON = 0.01;
const DATE_WINDOW_DAYS = 4;
const VENDOR_PREFIX_LEN = 40;

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
  rangeStart.setDate(rangeStart.getDate() - DATE_WINDOW_DAYS);
  const rangeEnd = new Date(paymentDate);
  rangeEnd.setDate(rangeEnd.getDate() + DATE_WINDOW_DAYS);

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
  for (const tx of allTxs) uniqueTxs.set(tx.id, tx);

  const paymentAmount = Number(payment.amount);

  // ===== Проход 1: точное совпадение =====
  const singleCandidates: number[] = [];
  for (const tx of uniqueTxs.values()) {
    const txAmount = Math.abs(Number(tx.amount));
    if (Math.abs(txAmount - paymentAmount) < AMOUNT_EPSILON) {
      singleCandidates.push(tx.id);
    }
  }

  const availableSingles = await filterTaken(singleCandidates, paymentId);
  if (availableSingles.length === 1) {
    const tx = uniqueTxs.get(availableSingles[0]);
    return {
      status: 'matched',
      transactionIds: [availableSingles[0]],
      existingDescription: tx?.description || '',
    };
  }
  if (availableSingles.length > 1) {
    return { status: 'needs_review', candidates: availableSingles.map((id) => [id]) };
  }

  // ===== Проход 2: композиция из 2 операций того же дня/контрагента =====
  const byDayVendor = new Map<string, AdeskTransaction[]>();
  for (const tx of uniqueTxs.values()) {
    const vendor = (tx.description || '').slice(0, VENDOR_PREFIX_LEN);
    const key = `${tx.date}|${vendor}`;
    const arr = byDayVendor.get(key) || [];
    arr.push(tx);
    byDayVendor.set(key, arr);
  }

  const pairs: number[][] = [];
  for (const txs of byDayVendor.values()) {
    if (txs.length < 2) continue;
    for (let i = 0; i < txs.length; i++) {
      for (let j = i + 1; j < txs.length; j++) {
        const a = Math.abs(Number(txs[i].amount));
        const b = Math.abs(Number(txs[j].amount));
        if (Math.abs(a + b - paymentAmount) < AMOUNT_EPSILON) {
          pairs.push([txs[i].id, txs[j].id]);
        }
      }
    }
  }

  const availablePairs: number[][] = [];
  for (const pair of pairs) {
    const avail = await filterTaken(pair, paymentId);
    if (avail.length === pair.length) availablePairs.push(pair);
  }

  if (availablePairs.length === 1) {
    const [id1] = availablePairs[0];
    const tx = uniqueTxs.get(id1);
    return {
      status: 'matched',
      transactionIds: availablePairs[0],
      existingDescription: tx?.description || '',
    };
  }
  if (availablePairs.length > 1) {
    return { status: 'needs_review', candidates: availablePairs };
  }

  return { status: 'not_found' };
}

async function filterTaken(txIds: number[], paymentId: string): Promise<number[]> {
  if (txIds.length === 0) return [];
  const taken = await prisma.payment.findMany({
    where: {
      adeskConfirmedTransactionId: { in: txIds },
      id: { not: paymentId },
    },
    select: { adeskConfirmedTransactionId: true },
  });
  const takenSet = new Set(
    taken.map((t) => t.adeskConfirmedTransactionId).filter(Boolean) as number[],
  );
  return txIds.filter((id) => !takenSet.has(id));
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

      const descParts = [payment.description, result.existingDescription].filter(Boolean);
      if (descParts.length > 0) {
        updates.description = descParts.join(' | ');
      }

      // Обновляем все привязанные транзакции (в композитных совпадениях их 2+)
      for (const txId of result.transactionIds) {
        await adesk.updateTransaction(txId, updates);
      }

      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'MATCHED',
          adeskConfirmedTransactionId: result.transactionIds[0],
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
        candidateTransactionIds: result.candidates.flat(),
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
