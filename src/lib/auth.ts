// src/lib/auth.ts
// Авторизация через Telegram Mini App initData.
// 1. Валидация HMAC-SHA256 подписи initData
// 2. Генерация / верификация JWT токена

import { createHmac, timingSafeEqual } from 'crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// Никакого дефолта: пустой JWT_SECRET — фатальная конфигурация, а не повод
// подписывать токены известной из репозитория константой. Функции ниже
// отказывают в работе (fail-closed), а не молча используют слабый секрет.
const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа
// Окно свежести initData. initData Telegram обновляет при каждом открытии
// мини-аппа, поэтому старше суток он быть не должен: отклоняем — это отсекает
// replay перехваченного initData (иначе он оставался бы вечным паролём).
const INITDATA_MAX_AGE_S = Number(process.env.TG_INITDATA_MAX_AGE_S) || 86_400;

// Constant-time сравнение hex-строк равной длины. false и при разной длине
// (timingSafeEqual бросает на буферах разного размера).
function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

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
  // Fail-closed: без токена бота secretKey = HMAC('WebAppData','') — публично
  // вычислимая константа, и любой смог бы подписать initData от чужого имени.
  if (!BOT_TOKEN) {
    console.error('[auth] TELEGRAM_BOT_TOKEN не задан — валидация initData отключена');
    return null;
  }
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

    if (!safeHexEqual(computedHash, hash)) return null;

    // Свежесть: перехваченный initData не должен работать вечно. Telegram
    // обновляет auth_date при каждом открытии, поэтому старее окна — отклоняем.
    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate) || authDate <= 0) return null;
    const ageS = Date.now() / 1000 - authDate;
    if (ageS > INITDATA_MAX_AGE_S) return null;

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
  // Без секрета не выпускаем токен — иначе он был бы подписан пустым ключом
  // и подделывался бы кем угодно.
  if (!JWT_SECRET) {
    throw new Error('[auth] JWT_SECRET не задан — выпуск токена невозможен');
  }
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
  // Fail-closed: без секрета любой токен считаем невалидным.
  if (!JWT_SECRET) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const expectedSig = sign(`${header}.${payload}`);
    // base64url-подписи — сравниваем constant-time (через hex-представление,
    // чтобы переиспользовать safeHexEqual и не течь по времени сравнения).
    if (
      !safeHexEqual(
        Buffer.from(signature, 'base64url').toString('hex'),
        Buffer.from(expectedSig, 'base64url').toString('hex'),
      )
    ) {
      return null;
    }

    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as JwtPayload;

    if (decoded.exp < Date.now()) return null;

    return decoded;
  } catch {
    return null;
  }
}
