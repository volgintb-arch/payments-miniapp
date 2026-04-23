// GET  /api/payments — список платежей текущего пользователя
// POST /api/payments — создание нового платежа + запуск ретро-матчинга
//
// Поддерживается два формата:
//   1) Простой платёж — одна статья/проект/контрагент (текущее поведение).
//   2) Сплит — поле splits[]: { unitId, adeskCategoryId, adeskProjectId?, adeskContractorId?, amount, description? }
//      sum(splits.amount) должен равняться amount. unitId платежа = unitId первого сплита
//      (общий юнит определяет bank-accounts для ретро-матча).

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, badRequest } from '@/lib/api-helpers';
import { processRetroMatch } from '@/lib/retro-match';
import { sendToGroup } from '@/lib/telegram';
import { adesk } from '@/lib/adesk/client';

type SplitInput = {
  unitId: number;
  adeskCategoryId: number;
  adeskProjectId?: number | null;
  adeskContractorId?: number | null;
  amount: number;
  description?: string;
};

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const url = request.nextUrl;
  const unitId = url.searchParams.get('unitId');
  const status = url.searchParams.get('status');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));

  const where: Record<string, unknown> = {};

  if (auth.role === 'EMPLOYEE') {
    where.userId = auth.userId;
  } else {
    const userUnits = await prisma.userUnit.findMany({
      where: { userId: auth.userId },
      select: { unitId: true },
    });
    where.unitId = { in: userUnits.map((u) => u.unitId) };
  }

  if (unitId) where.unitId = Number(unitId);
  if (status) where.status = status;

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { firstName: true, lastName: true } },
        unit: { select: { name: true } },
        splits: true,
      },
    }),
    prisma.payment.count({ where }),
  ]);

  return Response.json({
    payments: payments.map((p) => ({
      ...p,
      amount: Number(p.amount),
      splits: p.splits.map((s) => ({ ...s, amount: Number(s.amount) })),
      telegramId: undefined,
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => null);
  if (!body) return badRequest('Invalid JSON');

  const {
    unitId, adeskCategoryId, adeskProjectId, adeskContractorId,
    amount, date, description, cardNote, chatId, paymentMethod, safeId,
    splits: splitsRaw,
  } = body;

  const isCash = paymentMethod === 'cash';
  if (isCash && !safeId) {
    return badRequest('safeId is required for cash payments');
  }
  if (!amount || !date) {
    return badRequest('amount, date are required');
  }

  // Нормализуем сплиты
  const splits: SplitInput[] = Array.isArray(splitsRaw) && splitsRaw.length > 0
    ? splitsRaw.map((s: SplitInput) => ({
        unitId: Number(s.unitId),
        adeskCategoryId: Number(s.adeskCategoryId),
        adeskProjectId: s.adeskProjectId ? Number(s.adeskProjectId) : null,
        adeskContractorId: s.adeskContractorId ? Number(s.adeskContractorId) : null,
        amount: Number(s.amount),
        description: s.description || undefined,
      }))
    : [];

  const hasSplits = splits.length > 0;

  if (hasSplits) {
    // Валидация сплитов
    for (const s of splits) {
      if (!s.unitId || !s.adeskCategoryId || !s.amount) {
        return badRequest('Каждый сплит должен содержать unitId, adeskCategoryId, amount');
      }
    }
    const total = splits.reduce((sum, s) => sum + s.amount, 0);
    if (Math.abs(total - Number(amount)) >= 0.01) {
      return badRequest(`Сумма сплитов (${total}) не равна сумме платежа (${amount})`);
    }
  } else {
    if (!unitId || !adeskCategoryId) {
      return badRequest('unitId, adeskCategoryId are required (или передайте splits[])');
    }
  }

  // unitId платежа = unitId первого сплита (или явно переданный)
  const paymentUnitId = hasSplits ? splits[0].unitId : Number(unitId);

  // Проверяем доступ ко всем затронутым юнитам
  const unitIds = hasSplits
    ? Array.from(new Set(splits.map((s) => s.unitId)))
    : [paymentUnitId];
  const accessibleUnits = await prisma.userUnit.findMany({
    where: { userId: auth.userId, unitId: { in: unitIds } },
    select: { unitId: true },
  });
  if (accessibleUnits.length !== unitIds.length) {
    return Response.json({ error: 'No access to one or more units' }, { status: 403 });
  }

  // Снэпшоты имён (для платежа — берём из первого сплита или из body)
  const primaryCategoryId = hasSplits ? splits[0].adeskCategoryId : Number(adeskCategoryId);
  const primaryProjectId = hasSplits ? splits[0].adeskProjectId : (adeskProjectId ? Number(adeskProjectId) : null);
  const primaryContractorId = hasSplits ? splits[0].adeskContractorId : (adeskContractorId ? Number(adeskContractorId) : null);

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

  const contractorNameSnapshot = await getContractorName(primaryContractorId);
  const projectNameSnapshot = await getProjectName(primaryProjectId);

  // Снэпшоты для сплитов
  const splitsWithSnapshots = await Promise.all(
    splits.map(async (s) => ({
      ...s,
      contractorNameSnapshot: await getContractorName(s.adeskContractorId),
      projectNameSnapshot: await getProjectName(s.adeskProjectId),
    })),
  );

  const payment = await prisma.payment.create({
    data: {
      id: globalThis.crypto.randomUUID(),
      userId: auth.userId,
      unitId: paymentUnitId,
      adeskCategoryId: primaryCategoryId,
      adeskProjectId: primaryProjectId || null,
      adeskContractorId: primaryContractorId || null,
      contractorNameSnapshot,
      projectNameSnapshot,
      amount: Number(amount),
      date: new Date(date),
      description: description || null,
      cardNote: cardNote || null,
      paymentMethod: isCash ? 'cash' : 'card',
      adeskSafeId: isCash ? Number(safeId) : null,
      status: 'PENDING_RETRO',
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

  // Telegram-уведомление
  const unit = await prisma.unit.findUnique({ where: { id: paymentUnitId } });
  const category = await prisma.categoryCache.findUnique({ where: { adeskId: primaryCategoryId } });

  let tgText: string;
  if (hasSplits) {
    const headerParts = [
      unit?.name ?? 'Юнит',
      `${Number(amount).toLocaleString('ru-RU')} ₽`,
      isCash ? 'НАЛ' : (cardNote || 'Карта'),
      `Разделён на ${splits.length}`,
      description || '',
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
      `${Number(amount).toLocaleString('ru-RU')} ₽`,
      isCash ? 'НАЛ' : (cardNote || ''),
      description || '',
    ].filter(Boolean);
    tgText = parts.join(' / ');
  }

  sendToGroup(tgText, chatId || undefined).catch(() => {});

  if (isCash) {
    // Наличные — создаём транзакцию в Adesk сразу (await).
    // При ошибке платёж остаётся в PENDING_RETRO, крон подберёт.
    try {
      const res = await adesk.createTransaction({
        amount: Number(amount),
        date,
        type: 'outcome',
        bankAccountId: Number(safeId),
        categoryId: hasSplits ? undefined : primaryCategoryId,
        projectId: hasSplits ? undefined : (primaryProjectId ?? undefined),
        contractorId: hasSplits ? undefined : (primaryContractorId ?? undefined),
        description: description || undefined,
        parts: hasSplits
          ? splitsWithSnapshots.map((s) => ({
              amount: s.amount,
              categoryId: s.adeskCategoryId,
              projectId: s.adeskProjectId || undefined,
              contractorId: s.adeskContractorId || undefined,
              description: s.description || undefined,
            }))
          : undefined,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resAny = res as any;
      const txId = resAny.transaction?.id || resAny.transactions?.[0]?.id || resAny.id;
      if (txId) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'MATCHED',
            adeskConfirmedTransactionId: txId,
            matchedAt: new Date(),
          },
        });
      } else {
        console.error(`Cash transaction: Adesk did not return id for payment ${payment.id}`, res);
      }
    } catch (err) {
      console.error(`Cash transaction creation failed for payment ${payment.id}:`, err);
    }
  } else {
    processRetroMatch(payment.id).catch((err) => {
      console.error(`Retro-match failed for payment ${payment.id}:`, err);
    });
  }

  return Response.json(
    { payment: { ...payment, amount: Number(payment.amount) } },
    { status: 201 },
  );
}
