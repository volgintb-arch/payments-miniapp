// POST /api/auth/login
// Принимает Telegram initData, валидирует, находит/создаёт пользователя,
// возвращает JWT только для активных.
//
// Правила:
//   - Новый пользователь → create с isActive:false, БЕЗ auto-привязки юнитов.
//     Ответ: 200 { pending: true, firstName } — БЕЗ JWT. Клиент рисует
//     экран «доступ ещё не выдан», админ получает пинок в TG.
//   - Существующий, но !isActive → тоже { pending: true, firstName }.
//     isActive НЕ поднимаем автоматом (это и была дыра автоактивации).
//   - Активный → обновляем telegramUsername/firstName/lastName (только их —
//     не isActive, не role), выдаём JWT, возвращаем полную info.
//
// Уведомление админам о новом pending — fire-and-forget, ошибка Telegram
// не должна ронять сам логин.

import { validateInitData, createJwt } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { sendToGroup } from '@/lib/telegram';

// Куда слать «новый юзер ждёт активации». Если ENV не задан — падаем на
// общую группу расходов, чтобы уведомление не потерялось.
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || undefined;

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

  const telegramId = BigInt(tgUser.id);
  const existing = await prisma.user.findUnique({ where: { telegramId } });

  // === Ветка 1: пользователя нет — регистрируем как pending ===
  if (!existing) {
    const created = await prisma.user.create({
      data: {
        telegramId,
        telegramUsername: tgUser.username || null,
        firstName: tgUser.first_name,
        lastName: tgUser.last_name || null,
        role: 'EMPLOYEE',
        isActive: false,
        // allowedUnits не создаём — доступ к юнитам назначает админ отдельно.
      },
    });

    // Пинок админам. Не await'им — Telegram-таймаут не должен блокировать
    // клиента с его экраном pending.
    const tag = created.telegramUsername ? `@${created.telegramUsername}` : '';
    const fullName = `${created.firstName} ${created.lastName ?? ''}`.trim();
    const notifyText = [
      '🆕 Новый пользователь ждёт активации:',
      `${fullName}${tag ? ' · ' + tag : ''}`,
      `id: ${created.id}`,
    ].join('\n');
    sendToGroup(notifyText, ADMIN_CHAT_ID).catch((err) => {
      console.error('[auth/login] admin-notify failed:', err);
    });

    return Response.json({
      pending: true,
      firstName: created.firstName,
      lastName: created.lastName,
    });
  }

  // === Ветка 2: пользователь есть, но не активен ===
  if (!existing.isActive) {
    // Обновляем только визуальные поля — вдруг у него сменился username.
    // isActive и role НЕ трогаем.
    const refreshed = await prisma.user.update({
      where: { id: existing.id },
      data: {
        telegramUsername: tgUser.username || null,
        firstName: tgUser.first_name,
        lastName: tgUser.last_name || null,
      },
    });
    return Response.json({
      pending: true,
      firstName: refreshed.firstName,
      lastName: refreshed.lastName,
    });
  }

  // === Ветка 3: активный — обновляем profile-поля, выдаём JWT ===
  const user = await prisma.user.update({
    where: { id: existing.id },
    data: {
      telegramUsername: tgUser.username || null,
      firstName: tgUser.first_name,
      lastName: tgUser.last_name || null,
      // isActive и role НЕ трогаем.
    },
  });

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
