// Восстанавливает связь Payment ↔ Adesk-tx для висящих платежей, у которых
// соответствующая Adesk-tx УЖЕ имеет категорию (т.е. разнесена — бухгалтером
// вручную, или это след старого матча до фикса race condition).
//
// Adesk не трогаем — описание/категория/проект остаются как есть. В БД
// проставляем status=MATCHED + adeskConfirmedTransactionId, чтобы платёж
// перестал висеть в мини-аппе.
//
// Запуск:
//   node --env-file=.env scripts/auto-bind-categorized.mjs            # dry-run
//   node --env-file=.env scripts/auto-bind-categorized.mjs --apply

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const BASE = process.env.ADESK_API_BASE || 'https://api.adesk.ru';
const TOKEN = process.env.ADESK_API_TOKEN;
if (!TOKEN) { console.error('ADESK_API_TOKEN не задан'); process.exit(1); }

const apply = process.argv.includes('--apply');
const DATE_WINDOW = 4;          // как в матчере
const AMOUNT_EPSILON = 0.01;

const fmt = (d) => d.toISOString().split('T')[0];

async function adeskGet(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_token', TOKEN);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  const data = await res.json();
  if (data.success === false) throw new Error(`GET ${path}: ${data.message || JSON.stringify(data).slice(0,200)}`);
  return data;
}

function extractCardSuffix(cardNote) {
  if (!cardNote) return null;
  const digits = cardNote.match(/\d+/g);
  if (!digits) return null;
  const last = digits[digits.length - 1];
  return last.length >= 4 ? last.slice(-4) : null;
}
function isCardTransaction(desc) {
  if (!desc) return false;
  return /\d{4,6}\*+\d{2,4}/.test(desc) || /Терминал/i.test(desc);
}
function txMatchesCard(desc, suffix) {
  if (!suffix) return true;
  if (!desc) return false;
  return new RegExp(`\\*+${suffix}\\b`).test(desc);
}

console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

const hanging = await prisma.payment.findMany({
  where: {
    status: { in: ['PENDING_RETRO', 'NEEDS_REVIEW', 'ORPHANED'] },
    paymentMethod: 'card',
  },
  include: {
    user: { select: { telegramUsername: true } },
    unit: { select: { name: true } },
    splits: true,
  },
  orderBy: { createdAt: 'desc' },
});
console.log(`hanging payments: ${hanging.length}`);

const taken = await prisma.payment.findMany({
  where: { adeskConfirmedTransactionId: { not: null } },
  select: { adeskConfirmedTransactionId: true },
});
const takenIds = new Set(taken.map((t) => t.adeskConfirmedTransactionId));

const allBA = (await adeskGet('/v1/bank-accounts')).bankAccounts || [];

const txCache = new Map();
async function getTxs(baId, rs, re) {
  const key = `${baId}|${rs}|${re}`;
  if (txCache.has(key)) return txCache.get(key);
  const res = await adeskGet('/v1/transactions', {
    status: 'completed', type: 'outcome',
    bank_account: baId, range: 'custom',
    range_start: rs, range_end: re,
  });
  const list = res.transactions || [];
  txCache.set(key, list);
  return list;
}

async function unitBAs(p) {
  const ids = new Set([p.unitId]);
  for (const s of p.splits) ids.add(s.unitId);
  const rows = await prisma.unitBankAccount.findMany({
    where: { unitId: { in: Array.from(ids) } },
    select: { adeskBankAccountId: true },
  });
  return Array.from(new Set(rows.map((r) => r.adeskBankAccountId)));
}

const candidates = []; // { payment, tx }
let scanned = 0;

for (const p of hanging) {
  scanned++;
  const cardSuffix = extractCardSuffix(p.cardNote);
  const baIds = cardSuffix
    ? allBA.map((b) => b.id)
    : await unitBAs(p);
  if (!baIds.length) continue;

  const dateMs = +new Date(p.date);
  const createdMs = +p.createdAt;
  const lo = new Date(Math.min(dateMs, createdMs)); lo.setDate(lo.getDate() - DATE_WINDOW);
  const hi = new Date(Math.max(dateMs, createdMs)); hi.setDate(hi.getDate() + DATE_WINDOW);

  // Adesk не отдаёт range > 30 дней эффективно — разбиваем
  const chunks = [];
  let cur = new Date(lo);
  while (cur < hi) {
    const next = new Date(cur); next.setDate(next.getDate() + 30);
    chunks.push([fmt(cur), fmt(next > hi ? hi : next)]);
    cur = next;
  }

  const found = [];
  for (const [rs, re] of chunks) {
    // батчим по 5 счетов
    for (let i = 0; i < baIds.length; i += 5) {
      const batch = baIds.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map((b) => getTxs(b, rs, re)));
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (const tx of r.value) {
          if (!isCardTransaction(tx.description)) continue;
          if (!txMatchesCard(tx.description, cardSuffix)) continue;
          if (Math.abs(Number(tx.amount) - Number(p.amount)) >= AMOUNT_EPSILON) continue;
          // «Разнесена» в Adesk = есть категория ИЛИ проект (бухгалтер мог
          // проставить только что-то одно).
          if (!tx.category && !tx.project) continue;
          if (takenIds.has(tx.id)) continue;
          found.push(tx);
        }
      }
    }
  }

  // dedupe by tx.id
  const uniq = Array.from(new Map(found.map((t) => [t.id, t])).values());
  if (uniq.length === 1) {
    candidates.push({ payment: p, tx: uniq[0] });
  } else if (uniq.length > 1) {
    console.log(`! ${p.id} ${p.amount}₽ ${fmt(p.date)} card=${p.cardNote}: ${uniq.length} категоризированных кандидатов — пропуск (manual)`);
  }
}

console.log(`\nready to bind: ${candidates.length} / ${hanging.length}\n`);

for (const { payment: p, tx } of candidates) {
  const userTag = p.user.telegramUsername ? `@${p.user.telegramUsername}` : '';
  console.log(`bind ${p.id.slice(0,8)}… ${p.amount}₽ ${fmt(p.date)} ${p.unit.name} ${userTag} card=${p.cardNote}`);
  console.log(`  → tx=${tx.id} cat="${tx.category?.name ?? '—'}" proj="${tx.project?.name ?? '—'}"`);
}

if (!apply) {
  console.log('\nЗапусти с --apply чтобы записать в БД.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log('\n=== applying ===');
let ok = 0;
let fail = 0;
for (const { payment: p, tx } of candidates) {
  try {
    // CAS — только если статус всё ещё hanging (cron мог обновить параллельно)
    const r = await prisma.payment.updateMany({
      where: { id: p.id, status: { in: ['PENDING_RETRO', 'NEEDS_REVIEW', 'ORPHANED'] } },
      data: {
        status: 'MATCHED',
        adeskConfirmedTransactionId: tx.id,
        matchedAt: new Date(),
      },
    });
    if (r.count === 1) { ok++; }
    else { console.log(`  skip ${p.id.slice(0,8)}…: status already changed`); }
    await prisma.matchConflict.deleteMany({ where: { paymentId: p.id } });
  } catch (err) {
    fail++;
    console.error(`  fail ${p.id.slice(0,8)}…:`, err.message);
  }
}
console.log(`\nbound: ${ok}/${candidates.length}, failed: ${fail}`);

await prisma.$disconnect();
