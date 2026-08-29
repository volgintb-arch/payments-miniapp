// src/lib/adesk/idempotent.ts
//
// Идемпотентное создание транзакции в Adesk. Проблема: createTransaction не
// имеет ключа идемпотентности. Если Adesk принял операцию, но ответ пришёл
// после таймаута клиента (30s, а Adesk регулярно отвечает 15s+), исходный
// код не получал id и ретраил создание — крон делал это каждый час, задваивая
// расход в учёте. Здесь перед созданием ищем уже созданную транзакцию по
// счёту+дате+сумме+описанию и переиспользуем её.
//
// Ограничение: надёжно дедуплицировать можно только при непустом описании
// (иначе совпадение по сумме/дате/счёту зацепит чужую операцию). Без описания
// создаём напрямую — это осознанный компромисс, задокументированный тут.

import { adesk } from './client';
import type { AdeskTransaction } from './types';

export type CreateTxData = Parameters<typeof adesk.createTransaction>[0];

// Достаёт id созданной транзакции из ответа Adesk (v1 form → { transaction },
// v2 split → { transactions: [...] }). null, если id не распарсился.
export function extractCreatedTxId(res: unknown): number | null {
  const r = res as {
    transaction?: { id?: number };
    transactions?: Array<{ id?: number }>;
    id?: number;
  };
  const id = r?.transaction?.id ?? r?.transactions?.[0]?.id ?? r?.id;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

// Ищет уже существующую транзакцию, совпадающую с параметрами создания.
// Совпадением считаем: тот же счёт, тип, дата, |amount| и точное описание.
async function findExistingTx(data: CreateTxData): Promise<number | null> {
  const description = (data.description ?? '').trim();
  if (!description) return null; // без описания дедуп небезопасен

  const res = await adesk.listTransactions({
    status: 'completed',
    type: data.type,
    bankAccount: data.bankAccountId,
    rangeStart: data.date,
    rangeEnd: data.date,
  });
  const txs: AdeskTransaction[] = res.transactions || [];
  const target = Math.abs(Number(data.amount));
  const match = txs.find(
    (t) =>
      Math.abs(Math.abs(Number(t.amount)) - target) < 0.01 &&
      (t.description ?? '').trim() === description,
  );
  return match ? match.id : null;
}

export type IdempotentResult = {
  txId: number | null; // null — создано, но id не распарсился (нужен разбор)
  reused: boolean; // true — найдена уже существовавшая транзакция
};

// Найти-или-создать. Бросает, если создание в Adesk упало (после фикса
// клиента — на любой не-2xx / success:false), — вызывающий решает, что делать.
export async function createTransactionIdempotent(
  data: CreateTxData,
): Promise<IdempotentResult> {
  const existing = await findExistingTx(data);
  if (existing !== null) {
    return { txId: existing, reused: true };
  }
  const res = await adesk.createTransaction(data);
  return { txId: extractCreatedTxId(res), reused: false };
}
