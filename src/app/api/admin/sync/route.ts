// POST /api/admin/sync
// Синхронизация категорий из Adesk → CategoryCache.
// Только для ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { requireRole } from '@/lib/api-helpers';

export async function POST(request: NextRequest) {
  // Доступ по ADMIN_SECRET или JWT с ролью ADMIN
  const secret = request.headers.get('x-admin-secret');
  if (secret !== process.env.ADMIN_SECRET) {
    const auth = requireRole(request, ['ADMIN']);
    if (auth instanceof Response) return auth;
  }

  // Adesk API возвращает плоский список categories с полями:
  //   group: number (id группы)
  //   groupObject: { id, name, type }
  const outcomeRes = await adesk.getCategories({ type: 'outcome', fullGroup: true });
  const incomeRes = await adesk.getCategories({ type: 'income', fullGroup: true });

  const now = new Date();
  let synced = 0;

  for (const res of [outcomeRes, incomeRes]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const categories = (res as any).categories ?? [];
    for (const cat of categories) {
      // group — число, groupObject — объект с id/name
      const groupId: number | null = cat.group ?? cat.groupObject?.id ?? null;
      const groupName: string | null = cat.groupObject?.name ?? null;

      await prisma.categoryCache.upsert({
        where: { adeskId: cat.id },
        update: {
          name: cat.name,
          type: cat.type,
          adeskGroupId: groupId,
          adeskGroupName: groupName,
          isArchived: cat.isArchived ?? false,
          lastSyncedAt: now,
        },
        create: {
          adeskId: cat.id,
          name: cat.name,
          type: cat.type,
          adeskGroupId: groupId,
          adeskGroupName: groupName,
          isArchived: cat.isArchived ?? false,
          lastSyncedAt: now,
        },
      });
      synced++;
    }
  }

  return Response.json({ ok: true, synced });
}
