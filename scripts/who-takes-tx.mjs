// Кто из платежей в БД держит указанные Adesk-транзакции.
// Используется когда админка показывает кандидата как «занят» — нужно понять,
// что за платёж его держит, и принять решение: удалить дубль, отвязать
// ошибочный матч, или оставить как есть.
//
// Запуск:
//   node --env-file=.env scripts/who-takes-tx.mjs <txId> [<txId> ...]

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const txIds = process.argv.slice(2).map(Number).filter(Number.isFinite);

if (!txIds.length) {
  console.error('Usage: node scripts/who-takes-tx.mjs <txId> [<txId> ...]');
  process.exit(1);
}

const payments = await prisma.payment.findMany({
  where: { adeskConfirmedTransactionId: { in: txIds } },
  include: {
    user: { select: { firstName: true, lastName: true, telegramUsername: true } },
    unit: { select: { name: true } },
  },
});

for (const tid of txIds) {
  const p = payments.find((x) => x.adeskConfirmedTransactionId === tid);
  if (!p) {
    console.log(`tx ${tid}: NOT TAKEN (или платёж удалён из БД)\n`);
    continue;
  }
  const userTag = p.user.telegramUsername ? `@${p.user.telegramUsername}` : '';
  const userName = `${p.user.firstName} ${p.user.lastName ?? ''}`.trim();
  console.log(`tx ${tid}:`);
  console.log(`  paymentId: ${p.id}`);
  console.log(`  unit:      ${p.unit.name}`);
  console.log(`  user:      ${userTag} (${userName})`);
  console.log(`  amount:    ${p.amount}`);
  console.log(`  date:      ${p.date.toISOString().slice(0, 10)}`);
  console.log(`  cardNote:  ${p.cardNote ?? '—'}`);
  console.log(`  status:    ${p.status}`);
  console.log(`  desc:      ${p.description ?? '—'}`);
  console.log(`  createdAt: ${p.createdAt.toISOString()}`);
  console.log(`  matchedAt: ${p.matchedAt?.toISOString() ?? '—'}`);
  console.log();
}

await prisma.$disconnect();
