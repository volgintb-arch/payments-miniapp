// src/lib/api-helpers.ts
import { NextRequest } from 'next/server';
import { verifyJwt } from './auth';
import { prisma } from './db';

export type AuthUser = {
  userId: string;
  telegramId: number;
  role: string;
};

// JWT-only. Не проверяет БД. Используется только там, где нужен «сам факт
// валидного токена без гейта» (сейчас — нигде публично, оставлено как
// низкоуровневая утилита; для гейтов используйте requireAuth/requireRole).
export function decodeAuthToken(request: NextRequest): AuthUser | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const payload = verifyJwt(token);
  if (!payload) return null;
  return {
    userId: payload.sub,
    telegramId: payload.tgId,
    role: payload.role,
  };
}

// Основной гейт: валидный JWT + пользователь в БД + isActive=true. Роль
// берётся из БД (в JWT может быть stale, если админ поменял). Возвращает
// AuthUser или готовый Response с 401. Требует один БД-запрос на вызов —
// на текущей нагрузке это шум.
//
// Синхронный getAuthUser удалён намеренно: любой синхронный чекер обошёл
// бы проверку isActive и оставил дыру — тот же кейс, что чинили в
// omg-finance WP-04a (состояние читается из БД, а не из токена).
export async function getAuthUser(request: NextRequest): Promise<AuthUser | null> {
  const decoded = decodeAuthToken(request);
  if (!decoded) return null;
  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: { id: true, telegramId: true, role: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return {
    userId: user.id,
    telegramId: Number(user.telegramId),
    role: user.role,
  };
}

export async function requireAuth(request: NextRequest): Promise<AuthUser | Response> {
  const user = await getAuthUser(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return user;
}

export async function requireRole(
  request: NextRequest,
  allowedRoles: string[],
): Promise<AuthUser | Response> {
  const result = await requireAuth(request);
  if (result instanceof Response) return result;
  if (!allowedRoles.includes(result.role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  return result;
}

export function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

export function notFound(message = 'Not found') {
  return Response.json({ error: message }, { status: 404 });
}

export function serverError(message = 'Internal server error') {
  return Response.json({ error: message }, { status: 500 });
}
