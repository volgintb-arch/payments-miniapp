// GET /api/categories?unitId=1 — категории для юнита (из кэша)

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, badRequest } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const unitId = request.nextUrl.searchParams.get('unitId');
  if (!unitId) return badRequest('unitId is required');

  // Получаем группы статей юнита
  const unitGroups = await prisma.unitGroup.findMany({
    where: { unitId: Number(unitId) },
    orderBy: { sortOrder: 'asc' },
  });

  const groupIds = unitGroups.map((g) => g.adeskGroupId);

  // Категории из кэша по группам юнита
  const categories = await prisma.categoryCache.findMany({
    where: {
      adeskGroupId: { in: groupIds },
      isArchived: false,
    },
    orderBy: { name: 'asc' },
  });

  // Группируем по adeskGroupId
  const grouped = unitGroups.map((g) => ({
    groupId: g.adeskGroupId,
    groupName: g.adeskGroupName,
    categories: categories
      .filter((c) => c.adeskGroupId === g.adeskGroupId)
      .map((c) => ({ id: c.adeskId, name: c.name })),
  }));

  return Response.json({ groups: grouped });
}
