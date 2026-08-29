// POST /api/webhooks/adesk
// Вебхук от Adesk — срабатывает когда в Adesk появляется новая банковская
// операция. Мы в ответ перепрогоняем матчинг для всех PENDING_RETRO платежей
// (их обычно единицы), и если есть конкретная транзакция в payload — таргетно
// по её сумме ускоряем.
//
// Работаем даже если payload в непонятном формате — падаем в «перематчить всё».

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { processRetroMatch } from '@/lib/retro-match';
import { timingSafeStrEqual } from '@/lib/api-helpers';

const WEBHOOK_SECRET = process.env.ADESK_WEBHOOK_SECRET || '';

export async function POST(request: NextRequest) {
  // Fail-closed: пустой секрет — мисконфиг, а не «принимать всех». Иначе
  // неаутентифицированный POST запускает processRetroMatch и мутирует
  // финзаписи в Adesk. Секрет всё ещё принимается из query, потому что Adesk
  // зовёт зарегистрированный URL и не шлёт кастомных заголовков (см.
  // setup-webhook); подписи тела payload Adesk не предоставляет.
  if (!WEBHOOK_SECRET) {
    console.error('[adesk webhook] ADESK_WEBHOOK_SECRET не задан — вебхук закрыт');
    return Response.json({ error: 'Server misconfigured' }, { status: 503 });
  }
  const fromQuery = request.nextUrl.searchParams.get('secret') || '';
  const fromHeader = request.headers.get('x-webhook-secret') || '';
  if (!timingSafeStrEqual(fromQuery, WEBHOOK_SECRET) && !timingSafeStrEqual(fromHeader, WEBHOOK_SECRET)) {
    return Response.json({ error: 'Invalid secret' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  // Логируем только размер, не содержимое: payload может нести реквизиты
  // операций, а секрет вебхука лежит в query URL и попадает в логи.
  console.log('[adesk webhook] received, bytes:', JSON.stringify(body)?.length ?? 0);

  // Пытаемся вытащить сумму из payload (разные варианты схем Adesk)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = (body || {}) as any;
  const candidateAmount = Number(
    b?.data?.transaction?.amount ??
    b?.transaction?.amount ??
    b?.amount ??
    NaN,
  );

  const amt =
    Number.isFinite(candidateAmount) && candidateAmount > 0
      ? Math.abs(candidateAmount)
      : null;

  const pending = await prisma.payment.findMany({
    where: {
      status: 'PENDING_RETRO',
      paymentMethod: 'card',
      ...(amt !== null ? { amount: { gte: amt - 0.01, lte: amt + 0.01 } } : {}),
    },
    select: { id: true },
  });

  const results: { paymentId: string; status: string }[] = [];
  for (const p of pending) {
    try {
      const r = await processRetroMatch(p.id);
      results.push({ paymentId: p.id, status: r.status });
    } catch (err) {
      console.error(`[webhook] match failed for ${p.id}:`, err);
      results.push({ paymentId: p.id, status: 'error' });
    }
  }

  return Response.json({ ok: true, processed: results.length, results });
}

export async function GET() {
  return Response.json({ ok: true, endpoint: 'adesk-webhook' });
}
