// src/lib/telegram.ts
// Отправка сообщений в Telegram группу через Bot API.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || '';

// chatParam может быть:
//   "chatId" — обычная группа
//   "chatId_threadId" — супергруппа с топиком
export async function sendToGroup(text: string, chatParam?: string) {
  let targetChatId = CHAT_ID;
  let threadId: string | undefined;

  if (chatParam) {
    const parts = chatParam.split('_');
    if (parts.length >= 2 && parts[0].startsWith('-')) {
      // формат: -100xxxxxxxx_threadId
      targetChatId = parts[0];
      threadId = parts[1];
    } else {
      targetChatId = chatParam;
    }
  }

  if (!BOT_TOKEN || !targetChatId) return;

  try {
    const payload: Record<string, unknown> = {
      chat_id: targetChatId,
      text,
    };
    if (threadId) {
      payload.message_thread_id = Number(threadId);
    }

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram sendMessage error:', res.status, body);
    }
  } catch (err) {
    console.error('Telegram sendMessage failed:', err);
  }
}
