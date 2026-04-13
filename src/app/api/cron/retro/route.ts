// GET /api/cron/retro
// Cron-задача: раз в сутки перебирает все PENDING_RETRO платежи
// и запускает ретро-матчинг. Через 5 дней без совпадения → ORPHANED.

import { prisma } from '@/lib/db';
import { processRetroMatch } from '@/lib/retro-match';

const CRON_SECRET = process.env.CRON_SECRET || '';

export async function GET(request: Request) {
  // Защита: только по секретному ключу (Vercel Cron или аналог)
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const pendingPayments = await prisma.payment.findMany({
    where: { status: 'PENDING_RETRO' },
    orderBy: { createdAt: 'asc' },
  });

  const results: { paymentId: string; result: string }[] = [];

  for (const payment of pendingPayments) {
    try {
      const result = await processRetroMatch(payment.id);
      results.push({ paymentId: payment.id, result: result.status });
    } catch (err) {
      console.error(`Cron retro-match failed for ${payment.id}:`, err);
      results.push({ paymentId: payment.id, result: 'error' });
    }
  }

  return Response.json({
    ok: true,
    total: pendingPayments.length,
    results,
  });
}
