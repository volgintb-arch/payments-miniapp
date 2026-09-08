// src/lib/omg/client.ts
// Зеркало в omg-finance (D-025 там): всё, что сотрудник разнёс здесь,
// уходит и в Adesk (пока он основной), и в нашу систему учёта. Отправка
// fire-and-forget: ошибка логируется, поток с Adesk не ломается.
//
// ENV: OMG_API_URL (напр. https://erp.omgevent.ru), OMG_API_SECRET
// (= MINIAPP_API_SECRET в .env omg-finance). Без них — тихий no-op.

import { prisma } from '@/lib/db';

const BASE = (process.env.OMG_API_URL || '').replace(/\/+$/, '');
const SECRET = process.env.OMG_API_SECRET || '';
const TIMEOUT_MS = 15000;

export function omgEnabled(): boolean {
  return Boolean(BASE && SECRET);
}

type Ref = { adeskId: number; name: string } | null;

export type OmgPaymentPayload = {
  id: string;
  kind: 'CARD_PAYMENT' | 'CASH_PAYMENT' | 'CASH_INCOME' | 'ASSIGN';
  type: 'INCOME' | 'OUTCOME';
  amount: number;
  date: string;
  submittedAt: string;
  description: string | null;
  cardSuffix: string | null;
  author: string | null;
  unit: { name: string; adeskGroupIds: number[]; adeskLegalEntityId: number | null } | null;
  category: Ref;
  project: Ref;
  contractor: Ref;
  adeskSafeId: number | null;
  adeskTransactionId: number | null;
  adeskTx: { bankAccountId: number | null; date: string | null; amount: number | null; description: string | null } | null;
  parts:
    | Array<{
        unit: { name: string; adeskGroupIds: number[]; adeskLegalEntityId: number | null } | null;
        category: { adeskId: number; name: string };
        project: Ref;
        contractor: Ref;
        amount: number;
        description: string | null;
      }>
    | null;
  miniappStatus: string | null;
};

async function request(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
    if (!res.ok) {
      console.error(`[omg ${method} ${path}] ${res.status}`, typeof data === 'string' ? data : JSON.stringify(data));
      return null;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

// ── Сборка payload из БД ────────────────────────────────────────────────

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function authorTag(u: { telegramUsername: string | null; firstName: string; lastName: string | null } | null): string | null {
  if (!u) return null;
  if (u.telegramUsername) return `@${u.telegramUsername}`;
  return `${u.firstName} ${u.lastName ?? ''}`.trim() || null;
}

async function unitRef(unitId: number | null | undefined) {
  if (!unitId) return null;
  const u = await prisma.unit.findUnique({ where: { id: unitId }, include: { adeskGroups: true } });
  if (!u) return null;
  return { name: u.name, adeskGroupIds: u.adeskGroups.map((g) => g.adeskGroupId), adeskLegalEntityId: u.adeskLegalEntityId ?? null };
}

async function categoryRef(adeskId: number | null | undefined): Promise<Ref> {
  if (!adeskId) return null;
  const c = await prisma.categoryCache.findUnique({ where: { adeskId } });
  return { adeskId, name: c?.name ?? `Adesk ${adeskId}` };
}

async function projectRef(adeskId: number | null | undefined, snapshot?: string | null): Promise<Ref> {
  if (!adeskId) return null;
  const p = await prisma.projectCache.findUnique({ where: { adeskId } });
  return { adeskId, name: p?.name ?? snapshot ?? `Adesk ${adeskId}` };
}

async function contractorRef(adeskId: number | null | undefined, snapshot?: string | null): Promise<Ref> {
  if (!adeskId) return null;
  const c = await prisma.contractorCache.findUnique({ where: { adeskId } });
  return { adeskId, name: c?.name ?? snapshot ?? `Adesk ${adeskId}` };
}

function cardSuffixOf(cardNote: string | null | undefined): string | null {
  if (!cardNote) return null;
  const digits = cardNote.match(/\d+/g);
  if (!digits) return null;
  const last = digits[digits.length - 1];
  return last.length >= 4 ? last.slice(-4) : null;
}

/**
 * Собрать payload платежа. `adeskTx` — контекст банковской операции Adesk,
 * если известен (разнос выписки, ручной матч): помогает нашей системе
 * найти пару точнее.
 */
export async function buildPaymentPayload(
  paymentId: string,
  opts: { kind?: 'ASSIGN'; adeskTx?: OmgPaymentPayload['adeskTx']; operationId?: string } = {},
): Promise<(OmgPaymentPayload & { operationId?: string }) | null> {
  const p = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { splits: { orderBy: { sortOrder: 'asc' } }, user: { select: { telegramUsername: true, firstName: true, lastName: true } } },
  });
  if (!p) return null;
  const isCash = p.paymentMethod === 'cash';
  const parts = p.splits.length
    ? await Promise.all(
        p.splits.map(async (s) => ({
          unit: await unitRef(s.unitId),
          category: (await categoryRef(s.adeskCategoryId))!,
          project: await projectRef(s.adeskProjectId, s.projectNameSnapshot),
          contractor: await contractorRef(s.adeskContractorId, s.contractorNameSnapshot),
          amount: Number(s.amount),
          description: s.description,
        })),
      )
    : null;
  return {
    id: p.id,
    kind: opts.kind ?? (isCash ? 'CASH_PAYMENT' : 'CARD_PAYMENT'),
    type: 'OUTCOME',
    amount: Number(p.amount),
    date: iso(p.date),
    submittedAt: p.createdAt.toISOString(),
    description: p.description,
    cardSuffix: isCash ? null : cardSuffixOf(p.cardNote),
    author: authorTag(p.user),
    unit: await unitRef(p.unitId),
    category: await categoryRef(p.adeskCategoryId),
    project: await projectRef(p.adeskProjectId, p.projectNameSnapshot),
    contractor: await contractorRef(p.adeskContractorId, p.contractorNameSnapshot),
    adeskSafeId: isCash ? p.adeskSafeId : null,
    adeskTransactionId: p.adeskConfirmedTransactionId,
    adeskTx: opts.adeskTx ?? null,
    parts,
    miniappStatus: p.status,
    ...(opts.operationId ? { operationId: opts.operationId } : {}),
  };
}

export async function buildIncomePayload(incomeId: string): Promise<OmgPaymentPayload | null> {
  const i = await prisma.cashIncome.findUnique({
    where: { id: incomeId },
    include: { user: { select: { telegramUsername: true, firstName: true, lastName: true } } },
  });
  if (!i) return null;
  // У прихода нет юнита в мини-аппе; omg-finance возьмёт юнит по кассе или
  // по первому юниту сотрудника — передаём первый доступный юнит автора.
  const uu = await prisma.userUnit.findFirst({ where: { userId: i.userId }, orderBy: { unitId: 'asc' } });
  return {
    id: i.id,
    kind: 'CASH_INCOME',
    type: 'INCOME',
    amount: Number(i.amount),
    date: iso(i.date),
    submittedAt: i.createdAt.toISOString(),
    description: i.description,
    cardSuffix: null,
    author: authorTag(i.user),
    unit: await unitRef(uu?.unitId),
    category: await categoryRef(i.adeskCategoryId),
    project: await projectRef(i.adeskProjectId, i.projectNameSnapshot),
    contractor: await contractorRef(i.adeskContractorId, i.contractorNameSnapshot),
    adeskSafeId: i.adeskSafeId,
    adeskTransactionId: i.adeskTransactionId,
    adeskTx: null,
    parts: null,
    miniappStatus: i.status,
  };
}

// ── «Неопознанные» из omg-finance ───────────────────────────────────────

export type OmgUncategorizedItem = {
  txId: string;
  amount: number;
  date: string; // DD.MM.YYYY
  description: string;
  isCard: boolean;
  cardSuffix: string | null;
  bankAccount: { id: number; name: string; legalEntity: string | null };
};

/** Список операций без статьи из omg-finance (бросает — вызывающий показывает ошибку). */
export async function fetchOmgUncategorized(days: number, withNonCard: boolean): Promise<{ items: OmgUncategorizedItem[]; total: number }> {
  if (!omgEnabled()) throw new Error('omg-finance не настроен (OMG_API_URL / OMG_API_SECRET)');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/miniapp/uncategorized?days=${days}${withNonCard ? '&withNonCard=1' : ''}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: { items: OmgUncategorizedItem[]; total: number } } | null;
    if (!res.ok || !data?.ok || !data.data) throw new Error(data?.error || `omg-finance ответил ${res.status}`);
    return data.data;
  } finally {
    clearTimeout(t);
  }
}

// ── Публичные вызовы (не бросают) ───────────────────────────────────────

export async function syncPaymentToOmg(paymentId: string, opts: Parameters<typeof buildPaymentPayload>[1] = {}): Promise<void> {
  if (!omgEnabled()) return;
  try {
    const payload = await buildPaymentPayload(paymentId, opts);
    if (!payload) return;
    const res = await request('POST', '/api/miniapp/payments', payload);
    console.log(`[omg] payment ${paymentId} →`, JSON.stringify(res)?.slice(0, 200));
  } catch (err) {
    console.error(`[omg] sync payment ${paymentId} failed:`, err instanceof Error ? err.message : err);
  }
}

export async function syncIncomeToOmg(incomeId: string): Promise<void> {
  if (!omgEnabled()) return;
  try {
    const payload = await buildIncomePayload(incomeId);
    if (!payload) return;
    const res = await request('POST', '/api/miniapp/payments', payload);
    console.log(`[omg] income ${incomeId} →`, JSON.stringify(res)?.slice(0, 200));
  } catch (err) {
    console.error(`[omg] sync income ${incomeId} failed:`, err instanceof Error ? err.message : err);
  }
}

export async function unbindInOmg(paymentId: string): Promise<void> {
  if (!omgEnabled()) return;
  try {
    await request('POST', `/api/miniapp/payments/${encodeURIComponent(paymentId)}/unbind`);
  } catch (err) {
    console.error(`[omg] unbind ${paymentId} failed:`, err instanceof Error ? err.message : err);
  }
}

export async function cancelInOmg(id: string): Promise<void> {
  if (!omgEnabled()) return;
  try {
    await request('DELETE', `/api/miniapp/payments/${encodeURIComponent(id)}`);
  } catch (err) {
    console.error(`[omg] cancel ${id} failed:`, err instanceof Error ? err.message : err);
  }
}
