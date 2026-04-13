// src/lib/api-helpers.ts
import { NextRequest } from 'next/server';
import { verifyJwt } from './auth';

export type AuthUser = {
  userId: string;
  telegramId: number;
  role: string;
};

export function getAuthUser(request: NextRequest): AuthUser | null {
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

export function requireAuth(request: NextRequest): AuthUser | Response {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return user;
}

export function requireRole(
  request: NextRequest,
  allowedRoles: string[],
): AuthUser | Response {
  const result = requireAuth(request);
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
