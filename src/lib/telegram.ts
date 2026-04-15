// src/lib/telegram.ts
// Отправка сообщений в Telegram группу через Bot API.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || '';

export async function sendToGroup(text: string, chatId?: string) {
  const targetChatId = chatId || CHAT_ID;
  if (!BOT_TOKEN || !targetChatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram sendMessage error:', res.status, body);
    }
  } catch (err) {
    console.error('Telegram sendMessage failed:', err);
  }
}
