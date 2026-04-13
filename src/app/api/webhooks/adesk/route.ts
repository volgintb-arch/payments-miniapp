// POST /api/webhooks/adesk
// Вебхук от Adesk: event = transaction.created
// При получении новой фактической транзакции — ищем PENDING_RETRO платежи,
// которые совпадают по сумме и дате.

import { prisma } from '@/lib/db';
import { processRetroMatch } from '@/lib/retro-match';

const WEBHOOK_SECRET = process.env.ADESK_WEBHOOK_SECRET || '';

export async function POST(request: Request) {
  // Проверяем секрет (если настроен)
  if (WEBHOOK_SECRET) {
    const secret = request.headers.get('x-webhook-secret');
    if (secret !== WEBHOOK_SECRET) {
      return Response.json({ error: 'Invalid secret' }, { status: 401 });
    }
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { event, data } = body;

  if (event !== 'transaction.created') {
    return Response.json({ ok: true, skipped: true });
  }

  const tx = data?.transaction;
  if (!tx || !tx.amount) {
    return Response.json({ ok: true, skipped: true });
  }

  const txAmount = Math.abs(Number(tx.amount));
  const txBankAccountId = tx.bankAccount?.id;

  if (!txBankAccountId) {
    return Response.json({ ok: true, skipped: true });
  }

  // Ищем PENDING_RETRO платежи с совпадающей суммой
  // в юнитах, привязанных к этому банковскому счёту
  const unitBankAccounts = await prisma.unitBankAccount.findMany({
    where: { adeskBankAccountId: txBankAccountId },
    select: { unitId: true },
  });

  const unitIds = unitBankAccounts.map((uba) => uba.unitId);
  if (unitIds.length === 0) {
    return Response.json({ ok: true, skipped: true });
  }

  const pendingPayments = await prisma.payment.findMany({
    where: {
      status: 'PENDING_RETRO',
      unitId: { in: unitIds },
      amount: { gte: txAmount - 0.01, lte: txAmount + 0.01 },
    },
  });

  // Для каждого кандидата запускаем полный ретро-матчинг
  const results = [];
  for (const payment of pendingPayments) {
    try {
      const result = await processRetroMatch(payment.id);
      results.push({ paymentId: payment.id, result: result.status });
    } catch (err) {
      console.error(`Webhook retro-match failed for ${payment.id}:`, err);
      results.push({ paymentId: payment.id, result: 'error' });
    }
  }

  return Response.json({ ok: true, processed: results.length, results });
}
