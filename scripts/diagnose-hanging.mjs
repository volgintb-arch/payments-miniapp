// Сопоставляет все висящие платежи (PENDING_RETRO/NEEDS_REVIEW/ORPHANED, card)
// с outcome-tx из Adesk по ВСЕМ bank accounts (не только привязанным к юниту
// в UnitBankAccount). Цель — увидеть платежи, для которых tx реально есть,
// но матчер их не нашёл (например, потому что счёт не в UnitBankAccount).
//
// Запуск:
//   node --env-file=.env scripts/diagnose-hanging.mjs [--days=90] [--tol=10] [--card-only]
//
// --card-only — оставить только платежи с cardNote ровно из 4 цифр (отбросить
// легаси-заметки типа «точка Сережи», «карта белки» — их матчер по дизайну
// всё равно не цепляет, и они требуют ручного разбора).
//
// На каждый hanging выводит:
//   - метаданные платежа
//   - bankAccountIds, на которые ходит матчер (из UnitBankAccount)
//   - найденные кандидаты (close по сумме) по ВСЕМ счетам Adesk, с пометками:
//       * EXACT       — diff < 0.01
//       * UNIT_BA     — счёт привязан к юниту в БД (матчер должен был видеть)
//       * EXTRA_BA    — счёт НЕ привязан (матчер не видел → нужно добавить в UnitBankAccount)
//       * TAKEN       — другой Payment уже ссылается на эту tx
//       * UNCATEG     — в Adesk у этой tx нет category (то самое «неопознанные»)

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const BASE = process.env.ADESK_API_BASE || 'https://api.adesk.ru';
const TOKEN = process.env.ADESK_API_TOKEN;
if (!TOKEN) { console.error('ADESK_API_TOKEN не задан'); process.exit(1); }

const daysArg = process.argv.find((a) => a.startsWith('--days='));
const tolArg = process.argv.find((a) => a.startsWith('--tol='));
const DAYS = daysArg ? Number(daysArg.split('=')[1]) : 90;
const TOL = tolArg ? Number(tolArg.split('=')[1]) : 10;
const CARD_ONLY = process.argv.includes('--card-only');

const fmt = (d) => d.toISOString().split('T')[0];

async function adeskGet(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_token', TOKEN);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  const data = await res.json();
  if (data.success === false) {
    throw new Error(`GET ${path}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

console.log(`window=±${DAYS}d  tolerance=${TOL}₽\n`);

const hangingRaw = await prisma.payment.findMany({
  where: {
    status: { in: ['PENDING_RETRO', 'NEEDS_REVIEW', 'ORPHANED'] },
    paymentMethod: 'card',
  },
  include: {
    user: { select: { firstName: true, lastName: true, telegramUsername: true } },
    unit: { select: { name: true } },
    splits: true,
  },
  orderBy: { createdAt: 'desc' },
});
const hanging = CARD_ONLY
  ? hangingRaw.filter((p) => /^\d{4}$/.test((p.cardNote || '').trim()))
  : hangingRaw;
console.log(`hanging payments: ${hanging.length}` + (CARD_ONLY ? `  (filtered from ${hangingRaw.length} by --card-only)` : '') + '\n');

const baResp = await adeskGet('/v1/bank-accounts');
const bankAccounts = baResp.bankAccounts || [];

// Группируем юниты → их bank accounts из БД (по этим счетам ходит матчер)
const allUnitIds = new Set();
for (const p of hanging) {
  allUnitIds.add(p.unitId);
  for (const s of p.splits) allUnitIds.add(s.unitId);
}
const unitBA = await prisma.unitBankAccount.findMany({
  where: { unitId: { in: Array.from(allUnitIds) } },
});
const unitBAByUnit = new Map();
for (const r of unitBA) {
  if (!unitBAByUnit.has(r.unitId)) unitBAByUnit.set(r.unitId, new Set());
  unitBAByUnit.get(r.unitId).add(r.adeskBankAccountId);
}

// Какие Adesk-tx уже привязаны к каким Payment'ам (для пометки TAKEN)
const matched = await prisma.payment.findMany({
  where: { adeskConfirmedTransactionId: { not: null } },
  select: { id: true, adeskConfirmedTransactionId: true },
});
const takenBy = new Map();
for (const m of matched) takenBy.set(m.adeskConfirmedTransactionId, m.id);

// Кэш транзакций по bankAccount × окно
const txCache = new Map();
async function getTxsForBA(baId, rangeStart, rangeEnd) {
  const key = `${baId}|${rangeStart}|${rangeEnd}`;
  if (txCache.has(key)) return txCache.get(key);
  const resp = await adeskGet('/v1/transactions', {
    status: 'completed',
    type: 'outcome',
    bank_account: baId,
    range: 'custom',
    range_start: rangeStart,
    range_end: rangeEnd,
  });
  const list = resp.transactions || [];
  txCache.set(key, list);
  return list;
}

let countExact = 0, countExactExtra = 0, countExactTaken = 0, countNoTx = 0;

for (const p of hanging) {
  const center = new Date(p.date);
  const start = new Date(center); start.setDate(start.getDate() - DAYS);
  const end = new Date(center); end.setDate(end.getDate() + DAYS);

  const unitBAs = unitBAByUnit.get(p.unitId) || new Set();
  const splitBAs = new Set();
  for (const s of p.splits) {
    for (const b of (unitBAByUnit.get(s.unitId) || new Set())) splitBAs.add(b);
  }
  const matcherBAs = new Set([...unitBAs, ...splitBAs]);

  const hits = [];
  for (const ba of bankAccounts) {
    let cursor = new Date(start);
    while (cursor < end) {
      const chunkEnd = new Date(cursor); chunkEnd.setDate(chunkEnd.getDate() + 30);
      const rs = fmt(cursor);
      const re = fmt(chunkEnd > end ? end : chunkEnd);
      try {
        const txs = await getTxsForBA(ba.id, rs, re);
        for (const tx of txs) {
          const diff = Math.abs(Number(tx.amount) - Number(p.amount));
          if (diff <= TOL) {
            hits.push({ ba, tx, diff });
          }
        }
      } catch (err) {
        // молча — лог уже в getTxsForBA не пишет, не критично
      }
      cursor = chunkEnd;
    }
  }
  hits.sort((a, b) => a.diff - b.diff || (a.tx.date < b.tx.date ? -1 : 1));

  const userTag = p.user.telegramUsername ? `@${p.user.telegramUsername}` : '';
  const exactHits = hits.filter((h) => h.diff < 0.01);
  console.log(`▶ ${p.id}  ${p.amount}₽  ${fmt(p.date)}  unit=${p.unit.name}  user=${userTag}  card=${p.cardNote}  status=${p.status}  attempts=${p.retroAttempts}`);
  console.log(`  desc: ${p.description}`);
  console.log(`  matcher banks: [${[...matcherBAs].join(', ')}]`);
  if (hits.length === 0) {
    console.log(`  ⚠ нет ни одного кандидата в Adesk (±${TOL}₽, ±${DAYS}d) → tx в Adesk вообще нет`);
    countNoTx++;
  } else {
    for (const h of hits.slice(0, 6)) {
      const isUnit = matcherBAs.has(h.ba.id);
      const tags = [];
      tags.push(h.diff < 0.01 ? 'EXACT' : `Δ${h.diff.toFixed(2)}₽`);
      tags.push(isUnit ? 'UNIT_BA' : 'EXTRA_BA');
      if (takenBy.has(h.tx.id)) tags.push(`TAKEN(${takenBy.get(h.tx.id).slice(0, 8)}…)`);
      if (!h.tx.category) tags.push('UNCATEG');
      console.log(`    tx=${h.tx.id} ${h.tx.amount}₽ ${h.tx.date} ba=${h.ba.id} "${h.ba.name}" | ${tags.join(' ')}`);
      console.log(`      desc: ${(h.tx.description || '').slice(0, 110)}`);
    }
    if (exactHits.length) {
      countExact++;
      if (exactHits.some((h) => !matcherBAs.has(h.ba.id))) countExactExtra++;
      if (exactHits.some((h) => takenBy.has(h.tx.id))) countExactTaken++;
    } else {
      // Точного нет, но close есть — фактически это значит сумма не совпала
    }
  }
  console.log();
}

console.log(`\n=== summary ===`);
console.log(`total hanging:                       ${hanging.length}`);
console.log(`hanging with EXACT tx in Adesk:      ${countExact}`);
console.log(`  ↳ exact only on EXTRA_BA (счёт не привязан к юниту): ${countExactExtra}`);
console.log(`  ↳ exact TAKEN by other payment:    ${countExactTaken}`);
console.log(`hanging without ANY close tx:        ${countNoTx}`);

await prisma.$disconnect();
