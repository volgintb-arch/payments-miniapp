// Разруливает «висящий платёж VS точный кандидат-tx, занятый другим платежом».
//
// Получает все PENDING_RETRO/NEEDS_REVIEW/ORPHANED + их точные кандидаты с
// takenByPaymentId через /api/admin/pending, потом для каждой пары
// (hanging, takenBy) сравнивает userId/unitId/amount/date/cardNote/description:
//
//   • DUPLICATE_STRICT   — все 6 совпали → DELETE hanging
//   • SOFT_DUPLICATE     — user+unit+amount+cardNote+description совпали,
//                           только дата отличается (опечатка / повторный ввод)
//                           → DELETE hanging
//   • WRONG_AMOUNT       — у takenBy сумма НЕ равна tx.amount (= hanging.amount).
//                           takenBy зацепился ошибочно (старый race) → unmatch
//   • AMBIGUOUS          — разные user / unit / card / desc, обе суммы совпадают
//                           с tx. Кто правильный — без описания Adesk не понять.
//                           Скрипт ничего не делает, печатает «нужен ручной разбор».
//
// По умолчанию dry-run: только печатает классификацию. Применяет с --apply.
// После --apply скрипт сам дёрнет rematch.
//
// Запуск:
//   node --env-file=.env scripts/resolve-taken-conflicts.mjs
//   node --env-file=.env scripts/resolve-taken-conflicts.mjs --apply

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import fs from 'node:fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const apply = process.argv.includes('--apply');
const PORT = process.env.PORT || 3001;
const BASE = `http://localhost:${PORT}`;

// CRON_SECRET берём из .env (Next подгружает его, но это узел напрямую через
// --env-file=.env, кавычки в значениях NEXT_dotenv снимает не всегда — снимем
// сами, как делали в curl-командах).
const SECRET = (process.env.CRON_SECRET || '').replace(/^"|"$/g, '');
if (!SECRET) {
  console.error('CRON_SECRET не задан в окружении');
  process.exit(1);
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function authedFetch(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

const pending = await authedFetch('GET', '/api/admin/pending');
if (pending.status !== 200) {
  console.error(`/api/admin/pending → ${pending.status}:`, pending.data);
  process.exit(1);
}

// Adesk возвращает tx.date как "DD.MM.YYYY". Парсим в Date для diff.
function parseTxDate(s) {
  if (!s) return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}
function daysBetween(a, b) {
  return Math.round(Math.abs(a - b) / 86400000);
}

const rows = [];
for (const p of pending.data.payments || []) {
  const exactTaken = (p.candidates || []).filter(
    (c) => Math.abs(c.diff) < 0.01 && c.takenByPaymentId,
  );
  if (!exactTaken.length) continue;
  const c = exactTaken[0];
  rows.push({
    hangingId: p.id,
    txId: c.txId,
    takenById: c.takenByPaymentId,
    txDate: c.date,
    txDesc: c.description || '',
  });
}

if (!rows.length) {
  console.log('Конфликтов «exact-but-taken» не найдено.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Найдено пар (hanging × takenBy): ${rows.length}\n`);

const allPaymentIds = Array.from(new Set(rows.flatMap((r) => [r.hangingId, r.takenById])));
const payments = await prisma.payment.findMany({
  where: { id: { in: allPaymentIds } },
  include: { user: { select: { telegramUsername: true, firstName: true, lastName: true } } },
});
const byId = new Map(payments.map((p) => [p.id, p]));

const toDelete = [];   // hangingId — соответствуют DUPLICATE_STRICT и SOFT_DUPLICATE
const toUnmatch = [];  // takenById — WRONG_AMOUNT
const ambiguous = [];  // печатаем, не трогаем

const norm = (s) => (s || '').trim().toLowerCase();

for (const r of rows) {
  const h = byId.get(r.hangingId);
  const t = byId.get(r.takenById);
  if (!h || !t) {
    console.log(`! tx=${r.txId}: hanging или takenBy не найден в БД — пропуск`);
    continue;
  }
  const sameUser = h.userId === t.userId;
  const sameUnit = h.unitId === t.unitId;
  const sameAmount = Math.abs(Number(h.amount) - Number(t.amount)) < 0.01;
  const sameDate = fmtDate(h.date) === fmtDate(t.date);
  const sameCard = norm(h.cardNote) === norm(t.cardNote);
  const sameDesc = norm(h.description) === norm(t.description);

  let verdict;
  if (sameUser && sameUnit && sameAmount && sameDate && sameCard && sameDesc) {
    verdict = 'DUPLICATE_STRICT';
  } else if (sameUser && sameUnit && sameAmount && sameCard && sameDesc && !sameDate) {
    verdict = 'SOFT_DUPLICATE';
  } else if (!sameAmount) {
    // hanging.amount = tx.amount (close candidate diff<0.01), значит takenBy
    // когда-то прицепился к этой tx, имея ДРУГУЮ сумму — это явный ошибочный матч.
    verdict = 'WRONG_AMOUNT';
  } else {
    verdict = 'AMBIGUOUS';
  }

  // Подсказка по AMBIGUOUS: чья дата ближе к дате Adesk-tx?
  let dateHint = '';
  if (verdict === 'AMBIGUOUS') {
    const txD = parseTxDate(r.txDate);
    if (txD) {
      const dh = daysBetween(h.date, txD);
      const dt = daysBetween(t.date, txD);
      const closer = dh < dt ? 'hanging' : dt < dh ? 'takenBy' : 'equal';
      dateHint = `  tx.date=${r.txDate}  Δhanging=${dh}d  ΔtakenBy=${dt}d  closer=${closer}`;
    }
  }

  console.log(`tx=${r.txId}  hanging=${h.id.slice(0,8)}…  takenBy=${t.id.slice(0,8)}…  verdict=${verdict}`);
  console.log(`  hanging: ${h.amount}₽ ${fmtDate(h.date)} unit=${h.unitId} user=${h.userId.slice(0,8)} card=${h.cardNote} status=${h.status} desc=${(h.description || '').slice(0,40)}`);
  console.log(`  takenBy: ${t.amount}₽ ${fmtDate(t.date)} unit=${t.unitId} user=${t.userId.slice(0,8)} card=${t.cardNote} status=${t.status} desc=${(t.description || '').slice(0,40)}`);
  if (dateHint) console.log(dateHint);
  if (verdict === 'AMBIGUOUS' && r.txDesc) {
    console.log(`  tx.desc: ${r.txDesc.slice(0, 120)}`);
  }
  console.log();

  if (verdict === 'DUPLICATE_STRICT' || verdict === 'SOFT_DUPLICATE') toDelete.push({ ...r, verdict });
  else if (verdict === 'WRONG_AMOUNT') toUnmatch.push({ ...r, verdict });
  else ambiguous.push({ ...r, verdict });
}

console.log(`\n=== summary ===`);
console.log(`DELETE hanging:     ${toDelete.length}   (DUPLICATE_STRICT + SOFT_DUPLICATE)`);
console.log(`unmatch takenBy:    ${toUnmatch.length}   (WRONG_AMOUNT)`);
console.log(`AMBIGUOUS (manual): ${ambiguous.length}`);

if (ambiguous.length) {
  console.log('\nAMBIGUOUS — глазами разобрать (нужно описание Adesk-tx, чтобы понять кто прав):');
  for (const a of ambiguous) {
    console.log(`  hanging=${a.hangingId}  takenBy=${a.takenById}  tx=${a.txId}`);
  }
}

if (!apply) {
  console.log('\nЗапусти с --apply чтобы применить.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log('\n=== applying ===');

let okDel = 0, failDel = 0;
for (const r of toDelete) {
  const res = await authedFetch('DELETE', `/api/admin/pending/${r.hangingId}`);
  if (res.status === 200) { okDel++; console.log(`  DELETE ${r.verdict} hanging ${r.hangingId.slice(0,8)}… → ok`); }
  else { failDel++; console.log(`  DELETE hanging ${r.hangingId.slice(0,8)}… → ${res.status}`, res.data); }
}

let okUn = 0, failUn = 0;
for (const r of toUnmatch) {
  const res = await authedFetch('POST', `/api/admin/payments/${r.takenById}/unmatch`);
  if (res.status === 200) { okUn++; console.log(`  unmatch takenBy ${r.takenById.slice(0,8)}… → ok (released tx ${res.data.releasedTxId})`); }
  else { failUn++; console.log(`  unmatch takenBy ${r.takenById.slice(0,8)}… → ${res.status}`, res.data); }
}

console.log(`\ndeletes:   ${okDel}/${toDelete.length} ok, ${failDel} fail`);
console.log(`unmatches: ${okUn}/${toUnmatch.length} ok, ${failUn} fail`);

if (okUn > 0) {
  console.log('\nЗапускаю rematch чтобы освободившиеся tx подцепились к висящим…');
  const rm = await authedFetch('POST', '/api/admin/pending/rematch');
  if (rm.status === 200) {
    const counts = {};
    for (const r of rm.data.results || []) counts[r.status] = (counts[r.status] || 0) + 1;
    console.log('rematch:', rm.data.total, counts);
  } else {
    console.log('rematch fail:', rm.status, rm.data);
  }
}

await prisma.$disconnect();
