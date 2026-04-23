// src/lib/telegram.ts
// Отправка и редактирование сообщений в Telegram группу через Bot API.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || '';

export type SentMessage = {
  chatId: string;
  messageId: number;
  threadId?: number;
};

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
