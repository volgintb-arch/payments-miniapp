// src/lib/retro-match.ts
// Ретро-матчинг: ищет фактическую операцию в Adesk, совпадающую с платежом.
//
// Алгоритм:
//   1. Берём банковские счета ИМЕННО юнита платежа (+ юнитов сплитов).
//      userUnits-расширение НЕ используем — это плодило кросс-банковые матчи
//      между разными юр.лицами одного и того же сотрудника.
//   2. Запрашиваем completed-операции из Adesk за окно ±4 дня от даты платежа.
//   3. Фильтруем: только карточные операции (есть маска карты / "Терминал")
//      с тем же суффиксом карты, что и payment.cardNote.
//   4. Точное совпадение по сумме (±0.01) → 1 кандидат = MATCHED, >1 = NEEDS_REVIEW.
//   5. Если нет точного, пытаемся составное совпадение из 2 операций того же
//      дня/мерчанта — но всегда отправляем в NEEDS_REVIEW (auto-MATCH для пар
//      слишком склонен к ложным срабатываниям; админ подтверждает руками).
//   6. Сплит-платежи в составной матчинг не идут вообще (избежать двойного
//      учёта в Adesk).

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

// Карточные операции в Adesk содержат маску карты (220445******5443)
// или слово "Терминал" в описании. Прямые переводы со счёта (платёжки
// бухгалтера) их не содержат и матчиться не должны.
export function isCardTransaction(description?: string | null): boolean {
  if (!description) return false;
  return /\d{4,6}\*+\d{2,4}/.test(description) || /Терминал/i.test(description);
}

// Из cardNote ("2273", "Сбер *2273", "карта 2273") вытаскиваем последние
// 4 цифры — это суффикс карты, на которой делался платёж.
export function extractCardSuffix(cardNote?: string | null): string | null {
  if (!cardNote) return null;
  const digits = cardNote.match(/\d+/g);
  if (!digits) return null;
  const last = digits[digits.length - 1];
  return last.length >= 4 ? last.slice(-4) : null;
}

// Описание Adesk-операции содержит маску карты вида "220445******5443".
// Проверяем, что последние 4 цифры маски совпадают с суффиксом карты платежа.
export function txMatchesCard(
  description: string | null | undefined,
  cardSuffix: string | null,
): boolean {
  if (!cardSuffix) return true; // если суффикс не задан — не фильтруем
  if (!description) return false;
  return new RegExp(`\\*+${cardSuffix}\\b`).test(description);
}

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

  // Guard 1: уже привязан — не перематчиваем.
  if (payment.status === 'MATCHED' && payment.adeskConfirmedTransactionId) {
    return {
      status: 'matched',
      transactionIds: [payment.adeskConfirmedTransactionId],
    };
  }

  const cardSuffix = extractCardSuffix(payment.cardNote);

  // Guard 2: карточный платёж без cardNote — матчить нечего, иначе фильтр
  // по карте отключится и любая транзакция той же суммы может прицепиться.
  if (payment.paymentMethod === 'card' && !cardSuffix) {
    console.warn(`[match] payment ${paymentId} is card but has no cardNote — skip matching`);
    return { status: 'not_found' };
  }

  // Берём счета только юнита платежа (+ юнитов сплитов).
  // userUnits-расширение здесь использовать НЕЛЬЗЯ: оно даёт кандидатов
  // из чужих юр.лиц того же пользователя — уже ловили баг Локтионов↔Волгин.
  const unitIds = new Set<number>([payment.unitId]);
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
  for (const tx of allTxs) {
    if (!isCardTransaction(tx.description)) continue;
    if (!txMatchesCard(tx.description, cardSuffix)) continue;
    uniqueTxs.set(tx.id, tx);
  }

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

  // ===== Проход 2: композиция из 2 операций того же дня/мерчанта =====
  // Только для платежей без сплитов — иначе двойной учёт parts в Adesk.
  // И всегда NEEDS_REVIEW, чтобы админ подтвердил руками: пары слишком
  // склонны к ложному срабатыванию (два независимых Yandex Go ≈ одна
  // покупка той же суммы).
  if (payment.splits.length === 0) {
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

    if (availablePairs.length > 0) {
      return { status: 'needs_review', candidates: availablePairs };
    }
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
  // Уже сматчен — не дёргаем Adesk повторно (иначе накопим " | " в описании
  // и перезапишем статусом MATCHED с тем же ID).
  const initial = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { status: true, adeskConfirmedTransactionId: true },
  });
  if (initial?.status === 'MATCHED' && initial.adeskConfirmedTransactionId) {
    return { status: 'matched', transactionIds: [initial.adeskConfirmedTransactionId] };
  }

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

      // При переходе в MATCHED убираем висящие записи о конфликтах,
      // чтобы они не торчали в админке как «требует разбора».
      await prisma.matchConflict.deleteMany({ where: { paymentId } });
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
