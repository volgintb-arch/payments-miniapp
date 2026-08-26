// POST /api/admin/users/:id/activate
// Ставит isActive=true. Юниты НЕ раздаёт — это отдельная явная операция
// (не хотим повторять старую дыру, где все получали доступ ко всем юнитам).
//
// Доступ: JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/api-helpers';

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = getAuthUser(request);
  if (!auth || auth.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return Response.json({ error: 'User not found' }, { status: 404 });

  if (user.isActive) {
    return Response.json({ ok: true, alreadyActive: true, id: user.id });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: true },
    select: { id: true, firstName: true, isActive: true },
  });

  return Response.json({ ok: true, ...updated });
}
