// DELETE /api/admin/pending/:id — удалить «висящий» платёж (ошибка ввода, тест)
// POST   /api/admin/pending/:id/rematch — перезапустить матчер
//
// Доступ: Bearer CRON_SECRET или JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/api-helpers';

const CRON_SECRET = process.env.CRON_SECRET || '';

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return Response.json({ error: 'Not found' }, { status: 404 });
  if (payment.status === 'MATCHED') {
    return Response.json(
      { error: 'Cannot delete MATCHED payment — unbind in Adesk first' },
      { status: 409 },
    );
  }
  await prisma.payment.delete({ where: { id } });
  return Response.json({ ok: true, deleted: id });
}

function isAuthorized(request: NextRequest): boolean {
  const auth = request.headers.get('authorization');
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const user = getAuthUser(request);
  return user?.role === 'ADMIN';
}
