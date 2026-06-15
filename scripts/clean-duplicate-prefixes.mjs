// Чистит дубли префиксов вида "X | X | Y" → "X | Y" в описаниях Adesk-транзакций.
// Появились из-за race condition в processRetroMatch (закрыто отдельным коммитом),
// когда параллельные cron+rematch успевали оба обновить одну и ту же транзакцию.
//
// Запуск:
//   cd /root/payments-miniapp && node --env-file=.env scripts/clean-duplicate-prefixes.mjs [--dry-run] [--days=90]
//
// --dry-run — только показать что было бы изменено, без записи в Adesk.
// --days=N  — окно поиска (по умолчанию 90 дней назад от сегодня).

const BASE = process.env.ADESK_API_BASE || 'https://api.adesk.ru';
const TOKEN = process.env.ADESK_API_TOKEN;

if (!TOKEN) {
  console.error('ADESK_API_TOKEN не задан в окружении');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? Number(daysArg.split('=')[1]) || 90 : 90;

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
    throw new Error(`GET ${path} failed: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

async function adeskUpdateTx(id, body) {
  const url = new URL(`${BASE}/v2/transactions/update`);
  url.searchParams.set('api_token', TOKEN);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: [{ id, ...body }] }),
  });
  const data = await res.json();
  if (data.success === false) {
    throw new Error(`update ${id} failed: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

// Регекс ловит "X | X | rest…" с возможными пробелами вокруг |.
// При совпадении убираем второй "X |", оставляем первый.
const DUP_RE = /^(.+?)\s*\|\s*\1\s*\|/;

function cleanDescription(desc) {
  if (!desc) return null;
  let prev = desc;
  let curr = desc.replace(DUP_RE, '$1 |');
  // Не исключено что префикс задублировался ТРИ раза — повторяем пока не сойдётся.
  while (curr !== prev) {
    prev = curr;
    curr = curr.replace(DUP_RE, '$1 |');
  }
  return curr === desc ? null : curr;
}

async function main() {
  console.log(`=== clean-duplicate-prefixes ===`);
  console.log(`mode: ${dryRun ? 'DRY-RUN' : 'WRITE'} | window: ${days} days`);

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - days);

  const baResp = await adeskGet('/v1/bank-accounts');
  const bankAccounts = baResp.bankAccounts || [];
  console.log(`Bank accounts: ${bankAccounts.length}`);

  let scanned = 0;
  let dirty = 0;
  let fixed = 0;
  let failed = 0;

  // Идём окнами по 30 дней, чтобы Adesk не отдавал десятки тысяч за раз.
  const chunkDays = 30;
  for (const ba of bankAccounts) {
    let cursor = new Date(start);
    while (cursor < today) {
      const chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
      const rangeStart = fmt(cursor);
      const rangeEnd = fmt(chunkEnd > today ? today : chunkEnd);

      try {
        const resp = await adeskGet('/v1/transactions', {
          status: 'completed',
          type: 'outcome',
          bank_account: ba.id,
          range: 'custom',
          range_start: rangeStart,
          range_end: rangeEnd,
        });
        const txs = resp.transactions || [];
        scanned += txs.length;

        for (const tx of txs) {
          const cleaned = cleanDescription(tx.description);
          if (cleaned === null) continue;
          dirty++;
          const head = (tx.description || '').slice(0, 90).replace(/\s+/g, ' ');
          const headClean = cleaned.slice(0, 90).replace(/\s+/g, ' ');
          console.log(`tx ${tx.id} [ba=${ba.id} ${ba.name || ''}] ${tx.date}`);
          console.log(`  before: ${head}…`);
          console.log(`  after : ${headClean}…`);
          if (!dryRun) {
            try {
              await adeskUpdateTx(tx.id, { description: cleaned });
              fixed++;
            } catch (err) {
              failed++;
              console.error(`  FAIL: ${err.message}`);
            }
          }
        }
      } catch (err) {
        console.error(`[ba=${ba.id} ${rangeStart}..${rangeEnd}] ${err.message}`);
      }

      cursor = chunkEnd;
    }
  }

  console.log(`\n=== summary ===`);
  console.log(`scanned tx:   ${scanned}`);
  console.log(`with dup:     ${dirty}`);
  if (!dryRun) {
    console.log(`fixed:        ${fixed}`);
    console.log(`failed:       ${failed}`);
  } else {
    console.log(`(dry-run — ничего не записано)`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
