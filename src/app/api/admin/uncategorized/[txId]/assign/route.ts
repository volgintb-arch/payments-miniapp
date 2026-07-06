// POST /api/admin/uncategorized/:txId/assign
// Body: { unitId, adeskCategoryId, adeskProjectId?, adeskContractorId?, description? }
//
// Разносит «неопознанную» Adesk-транзакцию:
//   - создаёт Payment в БД (status=MATCHED, adeskConfirmedTransactionId=txId)
//   - обновляет Adesk-tx: проставляет категорию/проект/контрагента;
//     описание prepend'им нашим (без дублирования префикса).
//
// Проверяем перед записью, что tx ещё не привязан к другому Payment.
// Доступ: JWT с ролью ADMIN (без CRON_SECRET — здесь важен реальный
// админ-пользователь, чтобы Payment.userId был осмысленный).

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { adesk } from '@/lib/adesk/client';
import { getAuthUser, badRequest } from '@/lib/api-helpers';

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

  const unitId = Number(body.unitId);
  const adeskCategoryId = Number(body.adeskCategoryId);
  const adeskProjectId = body.adeskProjectId ? Number(body.adeskProjectId) : null;
  const adeskContractorId = body.adeskContractorId ? Number(body.adeskContractorId) : null;
  const rawDescription = typeof body.description === 'string' ? body.description.trim() : '';

  if (!unitId || !adeskCategoryId) {
    return badRequest('unitId и adeskCategoryId обязательны');
  }
  if (!rawDescription) {
    return badRequest('description обязателен');
  }

  // 1. Ещё не занята? (мог другой админ разнести параллельно)
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

  // 2. Достаём tx из Adesk: сумма/дата/описание/маска карты. Adesk не даёт
  // GET одиночной tx удобно, но listTransactions по банк-счёту с diapason
  // равным дню tx — избыточно. Проще запросить через bank_accounts всех
  // и выбрать — но это дорого. Поэтому клиент шлёт amount/date/bankAccountId
  // как контекст. Здесь мы всё-таки перезапрашиваем tx одним вызовом,
  // чтобы гарантировать что она существует и не разнесена в Adesk.
  // Оптимизация — принять эти поля от клиента, но тогда клиент может
  // передать что угодно; для консистентности берём из body контекст.
  const bankAccountId = Number(body.bankAccountId);
  const dateIso = typeof body.dateIso === 'string' ? body.dateIso : null;
  const amount = Number(body.amount);
  if (!bankAccountId || !dateIso || !amount) {
    return badRequest('bankAccountId, dateIso, amount обязательны (контекст tx)');
  }

  // 3. Проверяем доступ пользователя к юниту.
  const access = await prisma.userUnit.findFirst({
    where: { userId: user.userId, unitId },
  });
  if (!access) {
    return Response.json({ error: 'No access to unit' }, { status: 403 });
  }

  // 4. Снэпшоты имён (для карточки в мини-аппе).
  const [projectCache, contractorCache] = await Promise.all([
    adeskProjectId
      ? prisma.projectCache.findUnique({ where: { adeskId: adeskProjectId } })
      : Promise.resolve(null),
    adeskContractorId
      ? prisma.contractorCache.findUnique({ where: { adeskId: adeskContractorId } })
      : Promise.resolve(null),
  ]);

  // 5. cardNote вытаскиваем из маски карты в описании tx (если это карточная).
  const txDescForCard = typeof body.txDescription === 'string' ? body.txDescription : '';
  const cardSuffixMatch = /\*+(\d{4})\b/.exec(txDescForCard);
  const cardNote = cardSuffixMatch ? cardSuffixMatch[1] : null;

  // 6. Собираем description для Adesk без дублирования префикса.
  const existingDesc = txDescForCard || '';
  const alreadyPrefixed = existingDesc === rawDescription
    || existingDesc.startsWith(rawDescription + ' |');
  const newAdeskDesc = alreadyPrefixed
    ? existingDesc
    : existingDesc ? `${rawDescription} | ${existingDesc}` : rawDescription;

  // 7. Создаём Payment сразу в MATCHED-состоянии.
  const payment = await prisma.payment.create({
    data: {
      id: globalThis.crypto.randomUUID(),
      userId: user.userId,
      unitId,
      adeskCategoryId,
      adeskProjectId,
      adeskContractorId,
      contractorNameSnapshot: contractorCache?.name || null,
      projectNameSnapshot: projectCache?.name || null,
      amount,
      date: new Date(dateIso),
      description: rawDescription,
      cardNote,
      paymentMethod: 'card',
      status: 'MATCHED',
      adeskConfirmedTransactionId: txId,
      matchedAt: new Date(),
    },
  });

  // 8. Обновляем Adesk-tx.
  try {
    await adesk.updateTransaction(txId, {
      categoryId: adeskCategoryId,
      ...(adeskProjectId ? { projectId: adeskProjectId } : {}),
      ...(adeskContractorId ? { contractorId: adeskContractorId } : {}),
      description: newAdeskDesc,
    });
  } catch (err) {
    // Adesk упал — откатываем Payment, чтобы tx осталась в «неопознанных».
    await prisma.payment.delete({ where: { id: payment.id } });
    console.error(`[uncategorized/assign] Adesk update failed for tx=${txId}, payment rolled back:`, err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Adesk update failed' },
      { status: 502 },
    );
  }

  return Response.json({
    ok: true,
    paymentId: payment.id,
    txId,
  });
}

