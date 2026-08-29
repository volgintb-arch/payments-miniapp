// GET /api/admin/units — все юниты системы (для выдачи прав при активации).
// Доступ: ADMIN. Отдельно от /api/units, который возвращает только юниты
// текущего пользователя — из-за чего модалка активации показывала админу лишь
// его собственные юниты и не давала выдать новичку доступ к остальным.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { denyUnlessRoleStrict } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const denied = await denyUnlessRoleStrict(request, ['ADMIN']);
  if (denied) return denied;

  const units = await prisma.unit.findMany({ orderBy: { name: 'asc' } });
  return Response.json({ units });
}
