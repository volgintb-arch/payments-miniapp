// POST /api/sync-projects
// Быстрая синхронизация проектов из Adesk → кэш.
// Вызывается при открытии формы платежа/прихода.
// Rate-limit: не чаще раз в 60 секунд (глобально).

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { requireAuth } from '@/lib/api-helpers';

const MIN_INTERVAL_MS = 60 * 1000; // 1 минута
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
    const projectsRes = await adesk.getProjects();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projects = (projectsRes as any).projects ?? [];
    const stamp = new Date();
    let synced = 0;
    for (const proj of projects) {
      await prisma.projectCache.upsert({
        where: { adeskId: proj.id },
        update: {
          name: proj.name,
          adeskCategoryName: proj.category?.name ?? null,
          isArchived: proj.isArchived ?? false,
          isFinished: proj.isFinished ?? false,
          lastSyncedAt: stamp,
        },
        create: {
          adeskId: proj.id,
          name: proj.name,
          adeskCategoryName: proj.category?.name ?? null,
          isArchived: proj.isArchived ?? false,
          isFinished: proj.isFinished ?? false,
          lastSyncedAt: stamp,
        },
      });
      synced++;
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
