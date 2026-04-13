// src/lib/auth.ts
// Авторизация через Telegram Mini App initData.
// 1. Валидация HMAC-SHA256 подписи initData
// 2. Генерация / верификация JWT токена

import { createHmac } from 'crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

// ========================================
// Telegram initData validation
// ========================================

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
};

/**
 * Валидирует Telegram initData по спеке:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData: string): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    // Собираем data-check-string: все параметры кроме hash, отсортированные по ключу
    params.delete('hash');
    const entries = Array.from(params.entries());
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    // HMAC: secret_key = HMAC-SHA256("WebAppData", bot_token)
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (computedHash !== hash) return null;

    // Парсим user
    const userStr = params.get('user');
    if (!userStr) return null;

    const user = JSON.parse(userStr) as TelegramUser;
    if (!user.id || !user.first_name) return null;

    return user;
  } catch {
    return null;
  }
}

// ========================================
// JWT (минимальный, без внешних библиотек)
// ========================================

type JwtPayload = {
  sub: string;       // userId (cuid)
  tgId: number;      // telegramId
  role: string;      // UserRole
  exp: number;       // expiration (ms since epoch)
};

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
}

export function createJwt(userId: string, telegramId: number, role: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      tgId: telegramId,
      role,
      exp: Date.now() + JWT_TTL_MS,
    } satisfies JwtPayload),
  );
  const signature = sign(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const expectedSig = sign(`${header}.${payload}`);
    if (signature !== expectedSig) return null;

    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as JwtPayload;

    if (decoded.exp < Date.now()) return null;

    return decoded;
  } catch {
    return null;
  }
}
