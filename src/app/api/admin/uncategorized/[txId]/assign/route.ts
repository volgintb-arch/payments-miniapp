// POST /api/admin/uncategorized/:txId/assign
// Body: {
//   description, bankAccountId, dateIso, amount, txDescription,
//   // Простой режим:
//   unitId, adeskCategoryId, adeskProjectId?, adeskContractorId?,
//   // ИЛИ сплит-режим:
//   splits: [{ unitId, adeskCategoryId, adeskProjectId, adeskContractorId?, amount, description }, ...]
// }
//
// Разносит «неопознанную» Adesk-транзакцию:
//   - создаёт Payment в БД (status=MATCHED, adeskConfirmedTransactionId=txId)
//   - обновляет Adesk-tx: проставляет категорию/проект/контрагента ИЛИ
//     parts[] в сплит-режиме; описание prepend'им нашим (без дублирования).
//
// Проверяем перед записью, что tx ещё не привязан к другому Payment.
// Доступ: любой авторизованный (JWT), проверка userUnit — по каждому юниту.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { getAuthUser, badRequest } from '@/lib/api-helpers';
import { sendToGroup } from '@/lib/telegram';

function authorTag(u: { telegramUsername: string | null; firstName: string; lastName: string | null }): string {
  if (u.telegramUsername) return `@${u.telegramUsername}`;
  const name = `${u.firstName} ${u.lastName ?? ''}`.trim();
  return name || 'Без имени';
}

type SplitInput = {
  unitId: number;
  adeskCategoryId: number;
  adeskProjectId?: number | null;
  adeskContractorId?: number | null;
  amount: number;
  description?: string;
};

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ txId: string }> },
) {
  const user = getAuthUser(request);
  if (!user || user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const txIdRaw = (await ctx.params).txId;
  const txId = Number(txIdRaw);
  if (!Number.isFinite(txId) || txId <= 0) return badRequest('Invalid txId');

  const body = await request.json().catch(() => null);
  if (!body) return badRequest('Invalid JSON');

  const rawDescription = typeof body.description === 'string' ? body.description.trim() : '';
  if (!rawDescription) return badRequest('description обязателен');

  const bankAccountId = Number(body.bankAccountId);
  const dateIso = typeof body.dateIso === 'string' ? body.dateIso : null;
  const amount = Number(body.amount);
  if (!bankAccountId || !dateIso || !amount) {
    return badRequest('bankAccountId, dateIso, amount обязательны (контекст tx)');
  }

  // Нормализуем сплиты.
  const splits: SplitInput[] = Array.isArray(body.splits) && body.splits.length > 0
    ? body.splits.map((s: SplitInput) => ({
        unitId: Number(s.unitId),
        adeskCategoryId: Number(s.adeskCategoryId),
        adeskProjectId: s.adeskProjectId ? Number(s.adeskProjectId) : null,
        adeskContractorId: s.adeskContractorId ? Number(s.adeskContractorId) : null,
        amount: Number(s.amount),
        description: s.description || undefined,
      }))
    : [];
  const hasSplits = splits.length > 0;

  let unitId = 0;
  let adeskCategoryId = 0;
  let adeskProjectId: number | null = null;
  let adeskContractorId: number | null = null;

  if (hasSplits) {
    for (const s of splits) {
      if (!s.unitId || !s.adeskCategoryId || !s.adeskProjectId || !s.amount
        || !s.description || !String(s.description).trim()) {
        return badRequest('Каждый сплит должен содержать юнит, статью, проект, описание и сумму');
      }
    }
    const total = splits.reduce((sum, s) => sum + s.amount, 0);
    if (Math.abs(total - amount) >= 0.01) {
      return badRequest(`Сумма сплитов (${total}) не равна сумме транзакции (${amount})`);
    }
    // Primary-поля Payment'а — из первого сплита (как в /api/payments).
    unitId = splits[0].unitId;
    adeskCategoryId = splits[0].adeskCategoryId;
    adeskProjectId = splits[0].adeskProjectId ?? null;
    adeskContractorId = splits[0].adeskContractorId ?? null;
  } else {
    unitId = Number(body.unitId);
    adeskCategoryId = Number(body.adeskCategoryId);
    adeskProjectId = body.adeskProjectId ? Number(body.adeskProjectId) : null;
    adeskContractorId = body.adeskContractorId ? Number(body.adeskContractorId) : null;
    if (!unitId || !adeskCategoryId) {
      return badRequest('unitId и adeskCategoryId обязательны');
    }
  }

  // 1. Ещё не занята другим Payment?
  const already = await prisma.payment.findFirst({
    where: { adeskConfirmedTransactionId: txId },
    select: { id: true, userId: true },
  });
  if (already) {
    return Response.json(
      { error: 'Transaction already bound to another payment', paymentId: already.id },
      { status: 409 },
    );
  }

  // 2. Проверяем доступ пользователя ко ВСЕМ затронутым юнитам.
  const unitIds = Array.from(new Set(hasSplits ? splits.map((s) => s.unitId) : [unitId]));
  const accessible = await prisma.userUnit.findMany({
    where: { userId: user.userId, unitId: { in: unitIds } },
    select: { unitId: true },
  });
  if (accessible.length !== unitIds.length) {
    return Response.json(
      { error: 'No access to one or more units' },
      { status: 403 },
    );
  }

  // 3. Снэпшоты имён.
  async function getContractorName(id: number | null | undefined): Promise<string | null> {
    if (!id) return null;
    const c = await prisma.contractorCache.findUnique({ where: { adeskId: id } });
    return c?.name || null;
  }
  async function getProjectName(id: number | null | undefined): Promise<string | null> {
    if (!id) return null;
    const p = await prisma.projectCache.findUnique({ where: { adeskId: id } });
    return p?.name || null;
  }

  const contractorNameSnapshot = await getContractorName(adeskContractorId);
  const projectNameSnapshot = await getProjectName(adeskProjectId);
  const splitsWithSnapshots = await Promise.all(
    splits.map(async (s) => ({
      ...s,
      contractorNameSnapshot: await getContractorName(s.adeskContractorId),
      projectNameSnapshot: await getProjectName(s.adeskProjectId),
    })),
  );

  // 4. cardNote вытаскиваем из маски карты в описании tx.
  const txDescForCard = typeof body.txDescription === 'string' ? body.txDescription : '';
  const cardSuffixMatch = /\d{4,6}\*+(\d{4})\b/.exec(txDescForCard);
  const cardNote = cardSuffixMatch ? cardSuffixMatch[1] : null;

  // 5. Собираем description для Adesk без дублирования префикса.
  const existingDesc = txDescForCard || '';
  const alreadyPrefixed = existingDesc === rawDescription
    || existingDesc.startsWith(rawDescription + ' |');
  const newAdeskDesc = alreadyPrefixed
    ? existingDesc
    : existingDesc ? `${rawDescription} | ${existingDesc}` : rawDescription;

  // 6. Создаём Payment сразу в MATCHED-состоянии (со сплитами если нужно).
  const payment = await prisma.payment.create({
    data: {
      id: globalThis.crypto.randomUUID(),
      userId: user.userId,
      unitId,
      adeskCategoryId,
      adeskProjectId,
      adeskContractorId,
      contractorNameSnapshot,
      projectNameSnapshot,
      amount,
      date: new Date(dateIso),
      description: rawDescription,
      cardNote,
      paymentMethod: 'card',
      status: 'MATCHED',
      adeskConfirmedTransactionId: txId,
      matchedAt: new Date(),
      splits: hasSplits
        ? {
            create: splitsWithSnapshots.map((s, idx) => ({
              id: globalThis.crypto.randomUUID(),
              unitId: s.unitId,
              adeskCategoryId: s.adeskCategoryId,
              adeskProjectId: s.adeskProjectId || null,
              adeskContractorId: s.adeskContractorId || null,
              contractorNameSnapshot: s.contractorNameSnapshot,
              projectNameSnapshot: s.projectNameSnapshot,
              amount: s.amount,
              description: s.description || null,
              sortOrder: idx,
            })),
          }
        : undefined,
    },
  });

  // 7. Обновляем Adesk-tx (categoryId+projectId+contractorId ИЛИ parts[]).
  const adeskUpdates: Parameters<typeof adesk.updateTransaction>[1] = {
    description: newAdeskDesc,
  };
  if (hasSplits) {
    adeskUpdates.parts = splits.map((s) => ({
      amount: s.amount,
      categoryId: s.adeskCategoryId,
      projectId: s.adeskProjectId ?? undefined,
      contractorId: s.adeskContractorId ?? undefined,
      description: s.description ?? undefined,
    }));
  } else {
    adeskUpdates.categoryId = adeskCategoryId;
    if (adeskProjectId) adeskUpdates.projectId = adeskProjectId;
    if (adeskContractorId) adeskUpdates.contractorId = adeskContractorId;
  }

  try {
    await adesk.updateTransaction(txId, adeskUpdates);
  } catch (err) {
    // Adesk упал — откатываем Payment (splits уйдут каскадом).
    await prisma.payment.delete({ where: { id: payment.id } });
    console.error(`[uncategorized/assign] Adesk update failed for tx=${txId}, payment rolled back:`, err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Adesk update failed' },
      { status: 502 },
    );
  }

  // 8. Telegram-уведомление в чат — в том же формате, что и обычная подача
  // «Расход»/POST /api/payments. Собираем текст, потом сохраняем в Payment
  // tgChatId/tgMessageId для будущих правок (edit-message).
  const chatIdParam = typeof body.chatId === 'string' ? body.chatId : undefined;

  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  const category = await prisma.categoryCache.findUnique({ where: { adeskId: adeskCategoryId } });
  const author = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { telegramUsername: true, firstName: true, lastName: true },
  });
  const tag = author ? authorTag(author) : '';

  let tgText: string;
  if (hasSplits) {
    const headerParts = [
      unit?.name ?? 'Юнит',
      `${amount.toLocaleString('ru-RU')} ₽`,
      cardNote || 'Карта',
      `Разделён на ${splits.length}`,
      rawDescription,
      tag,
    ].filter(Boolean);
    const header = headerParts.join(' / ');
    const lines = await Promise.all(
      splitsWithSnapshots.map(async (s) => {
        const u = await prisma.unit.findUnique({ where: { id: s.unitId } });
        const c = await prisma.categoryCache.findUnique({ where: { adeskId: s.adeskCategoryId } });
        const row = [
          u?.name ?? 'Юнит',
          c?.name ?? 'Статья',
          s.projectNameSnapshot || '',
          `${s.amount.toLocaleString('ru-RU')} ₽`,
          s.description || '',
        ].filter(Boolean).join(' / ');
        return `  • ${row}`;
      }),
    );
    tgText = [header, ...lines].join('\n');
  } else {
    const parts = [
      unit?.name ?? 'Юнит',
      category?.name ?? 'Статья',
      projectNameSnapshot || '',
      `${amount.toLocaleString('ru-RU')} ₽`,
      cardNote || '',
      rawDescription,
      tag,
    ].filter(Boolean);
    tgText = parts.join(' / ');
  }

  // Fire-and-forget; ошибка в TG не должна ломать успешный ответ клиенту.
  sendToGroup(tgText, chatIdParam).then((sent) => {
    if (sent) {
      prisma.payment.update({
        where: { id: payment.id },
        data: {
          tgChatId: sent.chatId,
          tgMessageId: sent.messageId,
          tgThreadId: sent.threadId ?? null,
        },
      }).catch((e) => console.error('[uncategorized/assign] save tg msg id failed:', e));
    }
  }).catch(() => {});

  return Response.json({
    ok: true,
    paymentId: payment.id,
    txId,
    splits: splits.length,
  });
}
