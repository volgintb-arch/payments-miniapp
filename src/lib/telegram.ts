// src/lib/telegram.ts
// Отправка и редактирование сообщений в Telegram группу через Bot API.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || '';
// Необязательный allowlist разрешённых чатов/топиков (comma-separated id, вида
// "-100123..." или "-100123..._45"). Если задан — chatId из запроса клиента
// принимается, только если входит сюда; иначе уведомление уходит в дефолтную
// группу. Без него поведение прежнее (принимаем формат-валидный id).
const ALLOWED_CHATS = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export type SentMessage = {
  chatId: string;
  messageId: number;
  threadId?: number;
};

// Санитайзер chatId из тела запроса. chatId приходит с клиента (Telegram
// start_param) и раньше подставлялся в sendMessage как есть — сотрудник мог
// увести уведомление о платеже в личку/другой чат, обойдя контрольную группу.
// Возвращает безопасное значение для sendToGroup: сам chatParam, если он
// формат-валиден и (при заданном allowlist) разрешён, иначе undefined —
// тогда resolveTarget уходит в дефолтную группу.
export function sanitizeChatId(chatParam: unknown): string | undefined {
  if (typeof chatParam !== 'string' || !chatParam) return undefined;
  // Формат: "-100123..." или "-100123..._<threadId>". Группы всегда с минусом.
  if (!/^-\d+(_\d+)?$/.test(chatParam)) return undefined;
  if (ALLOWED_CHATS.size > 0 && !ALLOWED_CHATS.has(chatParam)) return undefined;
  return chatParam;
}

function resolveTarget(chatParam?: string): { chatId: string; threadId?: number } {
  let targetChatId = CHAT_ID;
  let threadId: number | undefined;

  if (chatParam) {
    const parts = chatParam.split('_');
    if (parts.length >= 2 && parts[0].startsWith('-')) {
      targetChatId = parts[0];
      threadId = Number(parts[1]);
    } else {
      targetChatId = chatParam;
    }
  }

  return { chatId: targetChatId, threadId };
}

// chatParam может быть:
//   "chatId" — обычная группа
//   "chatId_threadId" — супергруппа с топиком
export async function sendToGroup(
  text: string,
  chatParam?: string,
): Promise<SentMessage | null> {
  const { chatId, threadId } = resolveTarget(chatParam);
  if (!BOT_TOKEN || !chatId) return null;

  try {
    const payload: Record<string, unknown> = { chat_id: chatId, text };
    if (threadId) payload.message_thread_id = threadId;

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram sendMessage error:', res.status, body);
      return null;
    }
    const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
    if (!data.ok || !data.result) return null;
    return { chatId, messageId: data.result.message_id, threadId };
  } catch (err) {
    console.error('Telegram sendMessage failed:', err);
    return null;
  }
}

export async function editGroupMessage(
  chatId: string,
  messageId: number,
  text: string,
): Promise<boolean> {
  if (!BOT_TOKEN || !chatId || !messageId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram editMessageText error:', res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram editMessageText failed:', err);
    return false;
  }
}
