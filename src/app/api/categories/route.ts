// GET /api/categories?unitId=1          — статьи расходов юнита (из кэша)
// GET /api/categories?direction=income  — все статьи доходов (type=1)

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, badRequest } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const direction = request.nextUrl.searchParams.get('direction');

  if (direction === 'income') {
    const categories = await prisma.categoryCache.findMany({
      where: { type: 1, isArchived: false },
      orderBy: { name: 'asc' },
    });
    return Response.json({
      groups: [
        {
          groupId: 0,
          groupName: 'Доходы',
          categories: categories.map((c) => ({ id: c.adeskId, name: c.name })),
        },
      ],
    });
  }

  const unitId = request.nextUrl.searchParams.get('unitId');
  if (!unitId) return badRequest('unitId or direction=income is required');

  const unitGroups = await prisma.unitGroup.findMany({
    where: { unitId: Number(unitId) },
    orderBy: { sortOrder: 'asc' },
  });

  const groupIds = unitGroups.map((g) => g.adeskGroupId);

  const categories = await prisma.categoryCache.findMany({
    where: {
      adeskGroupId: { in: groupIds },
      isArchived: false,
    },
    orderBy: { name: 'asc' },
  });

  const grouped = unitGroups.map((g) => ({
    groupId: g.adeskGroupId,
    groupName: g.adeskGroupName,
    categories: categories
      .filter((c) => c.adeskGroupId === g.adeskGroupId)
      .map((c) => ({ id: c.adeskId, name: c.name })),
  }));

  return Response.json({ groups: grouped });
}
