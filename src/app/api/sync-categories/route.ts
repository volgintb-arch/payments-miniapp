// POST /api/sync-categories
// Быстрая синхронизация статей из Adesk → CategoryCache.
// Вызывается при открытии любой формы платежа/прихода.
// Rate-limit: не чаще раз в 5 минут (глобально).

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { requireAuth } from '@/lib/api-helpers';

const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 минут
let lastSyncAt = 0;
let inflight: Promise<number> | null = null;

export async function POST(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const now = Date.now();
  if (now - lastSyncAt < MIN_INTERVAL_MS) {
    return Response.json({ ok: true, skipped: true, reason: 'rate_limit' });
  }

  if (inflight) {
    const count = await inflight;
    return Response.json({ ok: true, joined: true, synced: count });
  }

  inflight = (async () => {
    const [outcomeRes, incomeRes] = await Promise.all([
      adesk.getCategories({ type: 'outcome', fullGroup: true }),
      adesk.getCategories({ type: 'income', fullGroup: true }),
    ]);

    const stamp = new Date();
    let synced = 0;

    for (const res of [outcomeRes, incomeRes]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const categories = (res as any).categories ?? [];
      for (const cat of categories) {
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
            lastSyncedAt: stamp,
          },
          create: {
            adeskId: cat.id,
            name: cat.name,
            type: cat.type,
            adeskGroupId: groupId,
            adeskGroupName: groupName,
            isArchived: cat.isArchived ?? false,
            lastSyncedAt: stamp,
          },
        });
        synced++;
      }
    }

    lastSyncAt = Date.now();
    return synced;
  })();

  try {
    const synced = await inflight;
    return Response.json({ ok: true, synced });
  } finally {
    inflight = null;
  }
}
