// POST /api/admin/users/:id/activate
// Body: { unitIds: number[] }
//
// Атомарно активирует пользователя и назначает ему указанные юниты.
// Пустой список допустим (админ мог сознательно оставить без юнитов — тогда
// человек не сможет подавать платежи, клиент обязан явно об этом предупредить).
// Юниты добавляются к существующим (skipDuplicates), не пересоздаются —
// повторный вызов с тем же списком идемпотентен.
//
// Доступ: JWT с ролью ADMIN.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { denyUnlessRole, badRequest } from '@/lib/api-helpers';

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = await denyUnlessRole(request, ['ADMIN']);
  if (denied) return denied;

  const { id } = await ctx.params;
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.unitIds)) {
    return badRequest('unitIds[] обязателен (может быть пустым)');
  }
  const unitIds: number[] = body.unitIds
    .map((n: unknown) => Number(n))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  // Дедуп
  const uniqueUnitIds = Array.from(new Set(unitIds));

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return Response.json({ error: 'User not found' }, { status: 404 });

  // Валидируем что все юниты существуют — не хотим засорять UserUnit
  // ссылками на несуществующие юниты (foreign key всё равно защитит, но
  // лучше поймать раньше и вернуть внятную ошибку).
  if (uniqueUnitIds.length > 0) {
    const existingUnits = await prisma.unit.findMany({
      where: { id: { in: uniqueUnitIds } },
      select: { id: true },
    });
    if (existingUnits.length !== uniqueUnitIds.length) {
      const found = new Set(existingUnits.map((u) => u.id));
      const missing = uniqueUnitIds.filter((id) => !found.has(id));
      return badRequest(`Юниты не найдены: ${missing.join(', ')}`);
    }
  }

  // Атомарно: isActive=true + добавить UserUnit-строки (skipDuplicates —
  // на случай, если у пользователя уже был какой-то доступ, например админ
  // уже давал ранее через SQL).
  await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: { isActive: true },
    }),
    ...(uniqueUnitIds.length > 0
      ? [
          prisma.userUnit.createMany({
            data: uniqueUnitIds.map((unitId) => ({ userId: id, unitId })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ]);

  return Response.json({
    ok: true,
    id,
    isActive: true,
    unitIdsAdded: uniqueUnitIds,
  });
}
