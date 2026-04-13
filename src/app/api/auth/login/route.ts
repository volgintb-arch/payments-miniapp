// POST /api/auth/login
// Принимает Telegram initData, валидирует, upsert пользователя, возвращает JWT.

import { validateInitData, createJwt } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const initData = body?.initData;

  if (!initData || typeof initData !== 'string') {
    return Response.json({ error: 'initData is required' }, { status: 400 });
  }

  const tgUser = validateInitData(initData);
  if (!tgUser) {
    return Response.json({ error: 'Invalid initData' }, { status: 401 });
  }

  // Upsert пользователя
  const user = await prisma.user.upsert({
    where: { telegramId: BigInt(tgUser.id) },
    update: {
      telegramUsername: tgUser.username || null,
      firstName: tgUser.first_name,
      lastName: tgUser.last_name || null,
    },
    create: {
      telegramId: BigInt(tgUser.id),
      telegramUsername: tgUser.username || null,
      firstName: tgUser.first_name,
      lastName: tgUser.last_name || null,
      role: 'EMPLOYEE',
      isActive: false,
    },
  });

  if (!user.isActive) {
    return Response.json(
      { error: 'Account is not activated. Contact admin.' },
      { status: 403 },
    );
  }

  const token = createJwt(user.id, Number(user.telegramId), user.role);

  return Response.json({
    token,
    user: {
      id: user.id,
      telegramId: Number(user.telegramId),
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
  });
}
