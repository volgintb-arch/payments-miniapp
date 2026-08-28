// DELETE /api/admin/pending/:id — удалить «висящий» платёж (ошибка ввода, тест)
// POST   /api/admin/pending/:id/rematch — перезапустить матчер
//
// Доступ: Bearer CRON_SECRET или JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { denyUnlessRole } from '@/lib/api-helpers';


export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = await denyUnlessRole(request, ['ADMIN']);
  if (denied) return denied;
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
