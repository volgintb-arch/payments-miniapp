// GET /api/projects?unitId=1&q=текст — проекты для юнита (из кэша, с поиском)

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, badRequest } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const unitId = request.nextUrl.searchParams.get('unitId');
  if (!unitId) return badRequest('unitId is required');

  const q = request.nextUrl.searchParams.get('q') || '';

  // Получаем категории проектов для этого юнита
  const unitProjCats = await prisma.unitProjectCategory.findMany({
    where: { unitId: Number(unitId) },
  });

  const catNames = unitProjCats.map((c) => c.adeskProjectCategory);

  if (catNames.length === 0) {
    return Response.json({ projects: [] });
  }

  // Фильтруем проекты из кэша
  const projects = await prisma.projectCache.findMany({
    where: {
      adeskCategoryName: { in: catNames },
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
