// src/lib/api-helpers.ts
import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { verifyJwt } from './auth';
import { prisma } from './db';

// Constant-time сравнение строк. false и при разной длине (timingSafeEqual
// бросает на буферах разного размера — длину при этом мы всё же раскрываем,
// это приемлемо для секретов фиксированной длины).
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Гейт для машинных роутов (cron, служебные вебхуки), защищённых CRON_SECRET.
// Fail-closed: пустой секрет — это мисконфиг, а не «пускать всех». Возвращает
// Response (503 — секрет не задан; 401 — секрет неверный) либо null.
export function denyUnlessCronSecret(request: Request): Response | null {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    console.error('[auth] CRON_SECRET не задан — машинный роут закрыт (fail-closed)');
    return Response.json({ error: 'Server misconfigured' }, { status: 503 });
  }
  const header = request.headers.get('authorization') || '';
  return timingSafeStrEqual(header, `Bearer ${secret}`)
    ? null
    : Response.json({ error: 'Unauthorized' }, { status: 401 });
}

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

// Машинный доступ для cron и служебных скриптов: Bearer CRON_SECRET в обход
// JWT. Секрет читаем на каждый вызов, а не в module scope — правка .env
// подхватывается рестартом pm2 без зависимости от порядка импортов.
export function hasCronSecret(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET || '';
  return secret !== '' && request.headers.get('authorization') === `Bearer ${secret}`;
}

// Гейт для admin-роутов: CRON_SECRET в обход, иначе JWT с одной из ролей.
// Возвращает готовый Response (401 — нет сессии, 403 — не та роль) либо null,
// если запрос можно обслуживать.
//
// Разделение 401 и 403 здесь не косметика. apiFetch на фронте на ЛЮБОЙ 401
// стирает токен и перезагружает страницу (см. lib/hooks/use-api.ts). Если
// отдавать 401 на промах по роли, сотрудник вместо понятной ошибки молча
// разлогинивается, приложение перезапускается и выбрасывает его на стартовую
// вкладку — со стороны это выглядит как «вкладка не открывается».
export async function denyUnlessRole(
  request: NextRequest,
  allowedRoles: string[],
): Promise<Response | null> {
  if (hasCronSecret(request)) return null;
  const result = await requireRole(request, allowedRoles);
  return result instanceof Response ? result : null;
}

// То же, но роль не важна — достаточно активной сессии (или CRON_SECRET).
export async function denyUnlessAuthed(request: NextRequest): Promise<Response | null> {
  if (hasCronSecret(request)) return null;
  const result = await requireAuth(request);
  return result instanceof Response ? result : null;
}

// Строгий вариант БЕЗ обхода по CRON_SECRET. Для управления правами
// (список пользователей, активация): машинный секрет крона лежит в конфиге
// планировщика/CI, где круг доступа шире, чем у админов, и не должен давать
// права администрировать пользователей.
export async function denyUnlessRoleStrict(
  request: NextRequest,
  allowedRoles: string[],
): Promise<Response | null> {
  const result = await requireRole(request, allowedRoles);
  return result instanceof Response ? result : null;
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
