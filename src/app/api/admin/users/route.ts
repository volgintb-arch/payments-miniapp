// GET /api/admin/users?pending=1
// Список пользователей. По умолчанию все, с ?pending=1 — только isActive=false
// (то есть ждущие активации после auth-фикса, где мы больше не поднимаем
// isActive автоматом).
//
// Доступ: JWT с ролью ADMIN. Никакого CRON_SECRET — это управление правами,
// а не read-only список; ошибиться дороже.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const auth = getAuthUser(request);
  if (!auth || auth.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pendingOnly = request.nextUrl.searchParams.get('pending') === '1';

  const users = await prisma.user.findMany({
    where: pendingOnly ? { isActive: false } : {},
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      telegramId: true,
      telegramUsername: true,
      firstName: true,
      lastName: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  });

  return Response.json({
    users: users.map((u) => ({
      ...u,
      telegramId: Number(u.telegramId), // BigInt → JSON.
    })),
  });
}
