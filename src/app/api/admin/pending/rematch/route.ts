// POST /api/admin/pending/rematch
// Перезапускает ретро-матчинг для всех PENDING_RETRO / NEEDS_REVIEW платежей.
// Используется из админки для ручного «пнуть матчер».
// Доступ: Bearer CRON_SECRET или JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { processRetroMatch } from '@/lib/retro-match';
import { getAuthUser } from '@/lib/api-helpers';

const CRON_SECRET = process.env.CRON_SECRET || '';

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const payments = await prisma.payment.findMany({
    where: {
      status: { in: ['PENDING_RETRO', 'NEEDS_REVIEW'] },
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

function isAuthorized(request: NextRequest): boolean {
  const auth = request.headers.get('authorization');
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const user = getAuthUser(request);
  return user?.role === 'ADMIN';
}
