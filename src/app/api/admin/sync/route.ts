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

  // Получаем все категории с группами (outcome)
  const outcomeRes = await adesk.getCategories({ type: 'outcome', fullGroup: true });
  const incomeRes = await adesk.getCategories({ type: 'income', fullGroup: true });

  const now = new Date();
  let synced = 0;

  // Обрабатываем категории из групп
  for (const res of [outcomeRes, incomeRes]) {
    const groups = res.groups ?? [];
    for (const group of groups) {
      for (const cat of group.categories ?? []) {
        await prisma.categoryCache.upsert({
          where: { adeskId: cat.id },
          update: {
            name: cat.name,
            type: cat.type,
            adeskGroupId: group.id,
            adeskGroupName: group.name,
            isArchived: cat.isArchived ?? false,
            lastSyncedAt: now,
          },
          create: {
            adeskId: cat.id,
            name: cat.name,
            type: cat.type,
            adeskGroupId: group.id,
            adeskGroupName: group.name,
            isArchived: cat.isArchived ?? false,
            lastSyncedAt: now,
          },
        });
        synced++;
      }
    }

    // Категории без группы
    const categories = res.categories ?? [];
    for (const cat of categories) {
      await prisma.categoryCache.upsert({
        where: { adeskId: cat.id },
        update: {
          name: cat.name,
          type: cat.type,
          adeskGroupId: cat.group?.id ?? null,
          adeskGroupName: cat.group?.name ?? null,
          isArchived: cat.isArchived ?? false,
          lastSyncedAt: now,
        },
        create: {
          adeskId: cat.id,
          name: cat.name,
          type: cat.type,
          adeskGroupId: cat.group?.id ?? null,
          adeskGroupName: cat.group?.name ?? null,
          isArchived: cat.isArchived ?? false,
          lastSyncedAt: now,
        },
      });
      synced++;
    }
  }

  return Response.json({ ok: true, synced });
}
