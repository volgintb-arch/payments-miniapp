// POST /api/admin/pending/rematch
// Перезапускает ретро-матчинг для всех PENDING_RETRO / NEEDS_REVIEW / ORPHANED
// платежей. Используется из админки для ручного «пнуть матчер».
// ORPHANED здесь нужен, чтобы платежи старше 5 дней (которые крон уже не
// берёт) можно было пересмотреть руками после фикса матчера/расширения окна.
// Доступ: Bearer CRON_SECRET или JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { processRetroMatch } from '@/lib/retro-match';
import { denyUnlessRole } from '@/lib/api-helpers';


export async function POST(request: NextRequest) {
  const denied = await denyUnlessRole(request, ['ADMIN']);
  if (denied) return denied;

  const payments = await prisma.payment.findMany({
    where: {
      status: { in: ['PENDING_RETRO', 'NEEDS_REVIEW', 'ORPHANED'] },
      paymentMethod: 'card',
    },
    select: { id: true },
  });

  const results: { paymentId: string; status: string }[] = [];
  for (const p of payments) {
    try {
      const r = await processRetroMatch(p.id);
      results.push({ paymentId: p.id, status: r.status });
    } catch (err) {
      console.error(`rematch failed for ${p.id}:`, err);
      results.push({ paymentId: p.id, status: 'error' });
    }
  }

  return Response.json({ ok: true, total: payments.length, results });
}
