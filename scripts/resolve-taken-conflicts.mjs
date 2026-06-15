// Разруливает «висящий платёж VS точный кандидат-tx, занятый другим платежом»:
//   • получает все PENDING_RETRO/NEEDS_REVIEW/ORPHANED + точные кандидаты с
//     takenByPaymentId через /api/admin/pending;
//   • для каждой пары (hanging, takenBy) сравнивает userId/amount/date/unitId:
//       - всё совпало         → ДУБЛЬ → удаляем hanging;
//       - что-то отличается   → ошибочный матч → unmatch takenBy
//                                (висящий сматчится сам через rematch).
//
// По умолчанию dry-run: только печатает решения. Применяет с --apply.
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

const rows = [];
for (const p of pending.data.payments || []) {
  const exactTaken = (p.candidates || []).filter(
    (c) => Math.abs(c.diff) < 0.01 && c.takenByPaymentId,
  );
  if (!exactTaken.length) continue;
  // Берём первого занятого exact-match (если их несколько — разруливаем
  // первый, остальные подберёт повторный прогон скрипта).
  rows.push({ hangingId: p.id, txId: exactTaken[0].txId, takenById: exactTaken[0].takenByPaymentId });
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

const duplicates = [];
const wrongMatches = [];

for (const r of rows) {
  const h = byId.get(r.hangingId);
  const t = byId.get(r.takenById);
  if (!h || !t) {
    console.log(`! tx=${r.txId}: hanging или takenBy не найден в БД — пропуск`);
    continue;
  }
  const sameUser = h.userId === t.userId;
  const sameAmount = Math.abs(Number(h.amount) - Number(t.amount)) < 0.01;
  const sameDate = fmtDate(h.date) === fmtDate(t.date);
  const sameUnit = h.unitId === t.unitId;
  const verdict = sameUser && sameAmount && sameDate && sameUnit ? 'DUPLICATE' : 'WRONG_MATCH';

  const head = `tx=${r.txId}  hanging=${h.id.slice(0, 8)}…  takenBy=${t.id.slice(0, 8)}…  verdict=${verdict}`;
  console.log(head);
  console.log(`  hanging: ${h.amount}₽ ${fmtDate(h.date)} unit=${h.unitId} user=${h.userId.slice(0,8)} card=${h.cardNote} status=${h.status} desc=${(h.description || '').slice(0,40)}`);
  console.log(`  takenBy: ${t.amount}₽ ${fmtDate(t.date)} unit=${t.unitId} user=${t.userId.slice(0,8)} card=${t.cardNote} status=${t.status} desc=${(t.description || '').slice(0,40)}`);
  console.log();

  if (verdict === 'DUPLICATE') duplicates.push(r);
  else wrongMatches.push(r);
}

console.log(`\n=== summary ===`);
console.log(`duplicates:    ${duplicates.length}   (action: DELETE hanging)`);
console.log(`wrong matches: ${wrongMatches.length}   (action: unmatch takenBy, then rematch)`);

if (!apply) {
  console.log('\nЗапусти с --apply чтобы применить.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log('\n=== applying ===');

let okDel = 0, failDel = 0;
for (const r of duplicates) {
  const res = await authedFetch('DELETE', `/api/admin/pending/${r.hangingId}`);
  if (res.status === 200) { okDel++; console.log(`  DELETE hanging ${r.hangingId.slice(0,8)}… → ok`); }
  else { failDel++; console.log(`  DELETE hanging ${r.hangingId.slice(0,8)}… → ${res.status}`, res.data); }
}

let okUn = 0, failUn = 0;
for (const r of wrongMatches) {
  const res = await authedFetch('POST', `/api/admin/payments/${r.takenById}/unmatch`);
  if (res.status === 200) { okUn++; console.log(`  unmatch takenBy ${r.takenById.slice(0,8)}… → ok (released tx ${res.data.releasedTxId})`); }
  else { failUn++; console.log(`  unmatch takenBy ${r.takenById.slice(0,8)}… → ${res.status}`, res.data); }
}

console.log(`\ndeletes: ${okDel}/${duplicates.length} ok, ${failDel} fail`);
console.log(`unmatches: ${okUn}/${wrongMatches.length} ok, ${failUn} fail`);

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
