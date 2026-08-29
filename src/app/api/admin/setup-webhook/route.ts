// POST /api/admin/setup-webhook
// Регистрирует webhook в Adesk для события transaction.created.
// Одноразовая настройка — вызывается руками с сервера.
// Доступ: Bearer CRON_SECRET.

import { NextRequest } from 'next/server';
import { adesk } from '@/lib/adesk/client';
import { denyUnlessCronSecret } from '@/lib/api-helpers';

const WEBHOOK_SECRET = process.env.ADESK_WEBHOOK_SECRET || '';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://pay.omgevent.ru';

export async function POST(request: NextRequest) {
  const denied = denyUnlessCronSecret(request);
  if (denied) return denied;

  const existing = await adesk.listWebhooks();

  const webhookUrl = `${PUBLIC_URL}/api/webhooks/adesk${
    WEBHOOK_SECRET ? `?secret=${encodeURIComponent(WEBHOOK_SECRET)}` : ''
  }`;

  const alreadyRegistered = existing.webhooks?.find(
    (w) => w.url === webhookUrl || w.url.startsWith(`${PUBLIC_URL}/api/webhooks/adesk`),
  );

  if (alreadyRegistered) {
    return Response.json({
      ok: true,
      action: 'already_registered',
      webhook: alreadyRegistered,
    });
  }

  const created = await adesk.createWebhook(
    webhookUrl,
    ['transaction.created'],
    'payments-miniapp: retro-match trigger',
  );

  return Response.json({ ok: true, action: 'created', webhook: created });
}

export async function GET(request: NextRequest) {
  const denied = denyUnlessCronSecret(request);
  if (denied) return denied;
  const existing = await adesk.listWebhooks();
  return Response.json(existing);
}
