// scripts/test-adesk.ts
// Ручной тест Adesk API клиента.
// Запуск: npx tsx scripts/test-adesk.ts
//
// Дёргает каждый метод и логирует ответ.
// НЕ создаёт и НЕ меняет данные (кроме поиска контрагентов).

import 'dotenv/config';
import { adesk } from '../src/lib/adesk/client';

async function main() {
  console.log('=== Adesk API Test ===\n');
  console.log(`API Base: ${process.env.ADESK_API_BASE}`);
  console.log(`Token: ${process.env.ADESK_API_TOKEN?.slice(0, 8)}...`);
  console.log();

  // 1. Юрлица
  console.log('--- 1. Legal Entities ---');
  try {
    const res = await adesk.getLegalEntities();
    console.log(`Found ${res.legalEntities?.length ?? 0} legal entities:`);
    for (const le of res.legalEntities ?? []) {
      console.log(`  id=${le.id} name="${le.name}"`);
    }
  } catch (e) {
    console.error('ERROR:', e);
  }
  console.log();

  // 2. Банковские счета
  console.log('--- 2. Bank Accounts ---');
  try {
    const res = await adesk.getBankAccounts();
    console.log(`Found ${res.bankAccounts?.length ?? 0} bank accounts:`);
    for (const ba of res.bankAccounts ?? []) {
      console.log(`  id=${ba.id} name="${ba.name}" bank="${ba.bankName ?? '?'}" entity="${ba.legalEntity?.name ?? '?'}"`);
    }
  } catch (e) {
    console.error('ERROR:', e);
  }
  console.log();

  // 3. Категории (с группами)
  console.log('--- 3. Categories (outcome, full_group) ---');
  try {
    const res = await adesk.getCategories({ type: 'outcome', fullGroup: true });
    const categories = res.categories ?? [];
    const groups = res.groups ?? [];
    console.log(`Found ${categories.length} categories, ${groups.length} groups`);
    if (groups.length > 0) {
      for (const g of groups.slice(0, 5)) {
        console.log(`  group id=${g.id} name="${g.name}" (${g.categories?.length ?? 0} categories)`);
      }
      if (groups.length > 5) console.log(`  ... and ${groups.length - 5} more groups`);
    } else {
      for (const c of categories.slice(0, 10)) {
        console.log(`  id=${c.id} name="${c.name}" type=${c.type} group=${c.group?.id ?? 'none'}`);
      }
      if (categories.length > 10) console.log(`  ... and ${categories.length - 10} more`);
    }
  } catch (e) {
    console.error('ERROR:', e);
  }
  console.log();

  // 4. Поиск контрагентов
  console.log('--- 4. Search Contractors (query="тест") ---');
  try {
    const res = await adesk.searchContractors('тест');
    const contractors = res.contractors ?? [];
    console.log(`Found ${contractors.length} contractors:`);
    for (const c of contractors.slice(0, 5)) {
      console.log(`  id=${c.id} name="${c.name}"`);
    }
  } catch (e) {
    console.error('ERROR:', e);
  }
  console.log();

  // 5. Список операций (последние 7 дней, расходы, фактические)
  console.log('--- 5. List Transactions (completed outcomes, last 7 days) ---');
  try {
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const fmt = (d: Date) => d.toISOString().split('T')[0];

    const res = await adesk.listTransactions({
      status: 'completed',
      type: 'outcome',
      rangeStart: fmt(weekAgo),
      rangeEnd: fmt(today),
    });
    const txs = res.transactions ?? [];
    console.log(`Found ${txs.length} transactions:`);
    for (const tx of txs.slice(0, 5)) {
      console.log(`  id=${tx.id} amount=${tx.amount} date="${tx.date}" desc="${tx.description?.slice(0, 50) ?? ''}"`);
    }
    if (txs.length > 5) console.log(`  ... and ${txs.length - 5} more`);
  } catch (e) {
    console.error('ERROR:', e);
  }
  console.log();

  // 6. Список вебхуков
  console.log('--- 6. Webhooks ---');
  try {
    const res = await adesk.listWebhooks();
    const hooks = res.webhooks ?? [];
    console.log(`Found ${hooks.length} webhooks:`);
    for (const h of hooks) {
      console.log(`  id=${h.id} url="${h.url}" events=${JSON.stringify(h.events)}`);
    }
  } catch (e) {
    console.error('ERROR:', e);
  }
  console.log();

  console.log('=== Done ===');
}

main().catch(console.error);
