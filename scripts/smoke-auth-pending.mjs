// Smoke-тест инварианта «pending-пользователь НЕ получает JWT».
//
// Что делает:
//   1. Cleanup: удаляет из БД тестовую запись User(telegramId=999000001)
//      если она осталась от предыдущего прогона (вместе с её UserUnit).
//   2. Генерирует валидный Telegram initData подписью HMAC-SHA256 через
//      TELEGRAM_BOT_TOKEN.
//   3. POST /api/auth/login с этим initData → ожидает 200 { pending: true }
//      БЕЗ token.
//   4. Второй прогон подряд (existing user, !isActive) — тоже 200
//      { pending: true } без token. Проверяем обе ветки (create + update-pending).
//   5. Cleanup после теста.
//
// Использует synthetic telegramId 999000001 (в endpoint для этого диапазона
// пропущена отправка admin-notify — см. isSyntheticTgId в auth/login/route.ts),
// чтобы прогоны не спамили админский чат и не оставляли фантомов.
//
// Запуск (на VPS):
//   node --env-file=.env scripts/smoke-auth-pending.mjs
//   node --env-file=.env scripts/smoke-auth-pending.mjs --url=https://pay.omgevent.ru
//
// Exit codes: 0 = pass, 1 = fail.

import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const SYNTHETIC_TG_ID = 999_000_001;
const DEFAULT_URL = 'http://localhost:3001';

const urlArg = process.argv.find((a) => a.startsWith('--url='));
const BASE = (urlArg ? urlArg.split('=')[1] : DEFAULT_URL).replace(/\/$/, '');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('FAIL: TELEGRAM_BOT_TOKEN не задан в окружении');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

function makeInitData(tgUser) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'smoke-' + Date.now(),
    user: JSON.stringify(tgUser),
  });
  const entries = Array.from(params.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.append('hash', hash);
  return params.toString();
}

async function cleanup() {
  const existing = await prisma.user.findUnique({
    where: { telegramId: BigInt(SYNTHETIC_TG_ID) },
    select: { id: true },
  });
  if (!existing) return { removed: false };
  await prisma.userUnit.deleteMany({ where: { userId: existing.id } });
  await prisma.user.delete({ where: { id: existing.id } });
  return { removed: true, userId: existing.id };
}

async function login(initData) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

console.log(`smoke-auth-pending against ${BASE}`);
console.log(`synthetic tg id: ${SYNTHETIC_TG_ID}\n`);

let anyFail = false;
try {
  // --- Pre-cleanup ---
  const pre = await cleanup();
  step('pre-cleanup', true, pre.removed ? `удалил остаток от прошлого запуска (${pre.userId})` : 'база чистая');

  const tgUser = {
    id: SYNTHETIC_TG_ID,
    first_name: 'SmokeTest',
    last_name: 'Auth',
    username: 'smoke_auth_test',
  };
  const initData = makeInitData(tgUser);

  // --- Прогон 1: create branch — новый пользователь, pending, без JWT ---
  console.log('\n[1] create branch (новый pending):');
  const r1 = await login(initData);
  step('HTTP 200', r1.status === 200, `status=${r1.status}`);
  step('body.pending === true', r1.body.pending === true, JSON.stringify(r1.body));
  step('body.firstName проброшен', r1.body.firstName === 'SmokeTest', `got: ${r1.body.firstName}`);
  step('НЕТ токена в ответе', !('token' in r1.body), 'ключа token быть не должно');

  // Проверим что в БД реально создан inactive
  const created = await prisma.user.findUnique({
    where: { telegramId: BigInt(SYNTHETIC_TG_ID) },
    select: { id: true, isActive: true, allowedUnits: { select: { unitId: true } } },
  });
  step('User создан в БД', !!created, `id=${created?.id}`);
  step('isActive=false', created?.isActive === false, `got: ${created?.isActive}`);
  step('без auto-привязки юнитов', (created?.allowedUnits?.length ?? -1) === 0,
    `units=${created?.allowedUnits?.length}`);

  // --- Прогон 2: update-pending branch — тот же юзер, всё ещё inactive ---
  console.log('\n[2] update-pending branch (второй заход существующего pending):');
  const r2 = await login(initData);
  step('HTTP 200', r2.status === 200, `status=${r2.status}`);
  step('body.pending === true', r2.body.pending === true, JSON.stringify(r2.body));
  step('НЕТ токена в ответе', !('token' in r2.body), 'ключа token быть не должно');

  // Проверим что isActive НЕ поднялся (это была старая дыра)
  const afterSecond = await prisma.user.findUnique({
    where: { telegramId: BigInt(SYNTHETIC_TG_ID) },
    select: { isActive: true },
  });
  step('isActive не поднялся при повторе', afterSecond?.isActive === false,
    `got: ${afterSecond?.isActive}`);
} catch (err) {
  console.error('\nUNEXPECTED ERROR:', err);
  anyFail = true;
} finally {
  // --- Post-cleanup ---
  console.log('\n[cleanup]');
  try {
    const post = await cleanup();
    step('post-cleanup', true, post.removed ? `удалил ${post.userId}` : 'нечего чистить');
  } catch (err) {
    step('post-cleanup', false, err instanceof Error ? err.message : String(err));
  }
  await prisma.$disconnect();
}

anyFail = anyFail || results.some((r) => !r.ok);
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;

console.log(`\n=== ${anyFail ? 'FAIL' : 'PASS'} — ${passed} ok / ${failed} fail ===`);
process.exit(anyFail ? 1 : 0);
