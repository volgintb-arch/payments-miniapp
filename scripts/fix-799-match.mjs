// Одноразовая чистка кривого матча платежа 799₽ ("Мяч для тенниса").
// Запуск:
//   cd /root/payments-miniapp && node --env-file=.env scripts/fix-799-match.mjs

const BASE = process.env.ADESK_API_BASE || 'https://api.adesk.ru';
const TOKEN = process.env.ADESK_API_TOKEN;

if (!TOKEN) {
  console.error('ADESK_API_TOKEN не задан в окружении');
  process.exit(1);
}

const ORIGINAL_YANDEX_DESC =
  'Покупка товара(Терминал:YANDEX*4121*GO,PASS 1-Y KRASNOGVARDEYSKIY 21 1,MOSCOW,RU,дата операции:28/05/2026 19:19(МСК),на сумму:331 RUB,карта 220445******3377)';

async function updateTx(id, body) {
  const url = new URL(`${BASE}/v2/transactions/update`);
  url.searchParams.set('api_token', TOKEN);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: [{ id, ...body }] }),
  });
  const data = await res.json();
  const tx = data?.data?.transactions?.[0];
  console.log(
    `tx ${id}: success=${data.success}, category=${tx?.category?.name ?? 'null'}, project=${tx?.project?.name ?? 'null'}, desc="${(tx?.description || '').slice(0, 60)}..."`,
  );
  if (data.success === false) {
    console.error(`  ОШИБКА:`, data.message || data.errorCode || JSON.stringify(data).slice(0, 300));
  }
  return data;
}

console.log('=== Шаг 1: сбрасываем категорию/проект и чистим описание у 126886292 (331₽ Yandex Go, Локтионов) ===');
await updateTx(126886292, {
  categoryId: null,
  projectId: null,
  description: ORIGINAL_YANDEX_DESC,
});

console.log('\n=== Шаг 2: убираем "Мяч для тенниса" из описания 126886316 (468₽ Yandex Go, Волгин), категорию/проект "Вечерняя логистика" не трогаем ===');
await updateTx(126886316, {
  description: `Вечерняя логистика | ${ORIGINAL_YANDEX_DESC}`,
});

console.log('\nГотово. Дальше нужно сбросить статус платежа в БД (см. инструкцию).');
