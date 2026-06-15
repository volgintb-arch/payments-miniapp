// Ищет outcome-tx в Adesk по сумме ± толеранс по ВСЕМ bank accounts.
// Помогает понять, где сидит «потерянная» транзакция, которую debug-match
// не показал — обычно потому что её bank account не привязан к юниту платежа
// в таблице UnitBankAccount.
//
// Запуск:
//   node --env-file=.env scripts/find-tx.mjs <amount> [<date> [days]]
//
// Примеры:
//   node --env-file=.env scripts/find-tx.mjs 6125 2026-05-21 90
//   node --env-file=.env scripts/find-tx.mjs 19643 2026-05-21 90
//   node --env-file=.env scripts/find-tx.mjs 714 2026-05-07 60
//
// На выходе — список совпадений (точных и близких ± толеранс) с указанием
// bank account и юр.лица. Сравни с тем что в admin/debug-match выдал как
// `bankAccountIds` — увидишь какие счета забыли добавить в UnitBankAccount.

const BASE = process.env.ADESK_API_BASE || 'https://api.adesk.ru';
const TOKEN = process.env.ADESK_API_TOKEN;

if (!TOKEN) {
  console.error('ADESK_API_TOKEN не задан');
  process.exit(1);
}

const amount = Number(process.argv[2]);
const dateStr = process.argv[3] || new Date().toISOString().split('T')[0];
const days = Number(process.argv[4]) || 60;
const TOLERANCE = 10;

if (!amount || !Number.isFinite(amount)) {
  console.error('Usage: node scripts/find-tx.mjs <amount> [<YYYY-MM-DD> [days]]');
  process.exit(1);
}

const fmt = (d) => d.toISOString().split('T')[0];
const center = new Date(dateStr);
const start = new Date(center);
start.setDate(start.getDate() - days);
const end = new Date(center);
end.setDate(end.getDate() + days);

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

console.log(`Search amount=${amount} ±${TOLERANCE}  window=${fmt(start)}..${fmt(end)}\n`);

const baResp = await adeskGet('/v1/bank-accounts');
const bankAccounts = baResp.bankAccounts || [];
console.log(`Bank accounts to scan: ${bankAccounts.length}`);

const hits = [];
const chunkDays = 30;
for (const ba of bankAccounts) {
  let cursor = new Date(start);
  while (cursor < end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
    const rs = fmt(cursor);
    const re = fmt(chunkEnd > end ? end : chunkEnd);
    try {
      const resp = await adeskGet('/v1/transactions', {
        status: 'completed',
        type: 'outcome',
        bank_account: ba.id,
        range: 'custom',
        range_start: rs,
        range_end: re,
      });
      for (const tx of resp.transactions || []) {
        const diff = Math.abs(Number(tx.amount) - amount);
        if (diff <= TOLERANCE) {
          hits.push({
            ba,
            tx,
            diff,
          });
        }
      }
    } catch (err) {
      console.error(`  ba=${ba.id} ${rs}..${re}: ${err.message}`);
    }
    cursor = chunkEnd;
  }
}

hits.sort((a, b) => a.diff - b.diff || (a.tx.date < b.tx.date ? -1 : 1));

console.log(`\nMatches (diff ≤ ${TOLERANCE}): ${hits.length}\n`);
for (const h of hits) {
  const le = h.ba.legalEntity?.name || '—';
  const baName = h.ba.name || h.ba.number || '—';
  console.log(`tx=${h.tx.id}  amt=${h.tx.amount}  date=${h.tx.date}  diff=${h.diff.toFixed(2)}`);
  console.log(`  bankAccount=${h.ba.id} "${baName}"  legalEntity="${le}"`);
  console.log(`  desc: ${(h.tx.description || '').slice(0, 140)}`);
  console.log();
}
