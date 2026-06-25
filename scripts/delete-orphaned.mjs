// Массовое удаление всех платежей со статусом ORPHANED.
// Запускается после auto-bind-categorized — то что не удалось привязать
// удаляем как недосматчиваемое (платежей за >5 дней без своей tx в Adesk).
//
// Adesk не трогаем. PaymentSplit удалится через onDelete: Cascade.
// MatchConflict для удаляемых платежей чистим явно (там нет cascade).
//
// Запуск:
//   node --env-file=.env scripts/delete-orphaned.mjs            # dry-run
//   node --env-file=.env scripts/delete-orphaned.mjs --apply

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const apply = process.argv.includes('--apply');

console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

const orphaned = await prisma.payment.findMany({
  where: { status: 'ORPHANED' },
  include: {
    user: { select: { telegramUsername: true, firstName: true } },
    unit: { select: { name: true } },
    splits: { select: { id: true } },
  },
  orderBy: { createdAt: 'asc' },
});

console.log(`ORPHANED payments: ${orphaned.length}\n`);
for (const p of orphaned) {
  const tag = p.user.telegramUsername ? `@${p.user.telegramUsername}` : p.user.firstName;
  console.log(`  ${p.id}  ${p.amount}₽  ${p.date.toISOString().slice(0,10)}  ${p.unit.name}  ${tag}  card=${p.cardNote ?? '—'}  splits=${p.splits.length}  desc=${(p.description ?? '').slice(0,40)}`);
}

if (!apply) {
  console.log('\nЗапусти с --apply чтобы удалить.');
  await prisma.$disconnect();
  process.exit(0);
}

const ids = orphaned.map((p) => p.id);

console.log('\nудаляю matchConflict-записи для этих платежей…');
const mc = await prisma.matchConflict.deleteMany({ where: { paymentId: { in: ids } } });
console.log(`  matchConflict удалено: ${mc.count}`);

console.log('удаляю сами Payment (splits уйдут каскадом)…');
const del = await prisma.payment.deleteMany({ where: { id: { in: ids } } });
console.log(`  Payment удалено: ${del.count}`);

await prisma.$disconnect();
