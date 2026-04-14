// GET /api/projects?q=текст — все проекты из кэша (с поиском)

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const q = request.nextUrl.searchParams.get('q') || '';

  const projects = await prisma.projectCache.findMany({
    where: {
      isArchived: false,
      isFinished: false,
      ...(q.length >= 2 ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
    },
    orderBy: { name: 'asc' },
    take: 50,
  });

  return Response.json({
    projects: projects.map((p) => ({ id: p.adeskId, name: p.name })),
  });
}
