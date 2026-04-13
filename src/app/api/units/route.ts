// GET /api/units — юниты текущего пользователя

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const userUnits = await prisma.userUnit.findMany({
    where: { userId: auth.userId },
    include: { unit: true },
  });

  return Response.json({
    units: userUnits.map((uu) => uu.unit),
  });
}
