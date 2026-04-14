// GET  /api/payments — список платежей текущего пользователя
// POST /api/payments — создание нового платежа + запуск ретро-матчинга

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, badRequest } from '@/lib/api-helpers';
import { processRetroMatch } from '@/lib/retro-match';
import { sendToGroup } from '@/lib/telegram';

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const url = request.nextUrl;
  const unitId = url.searchParams.get('unitId');
  const status = url.searchParams.get('status');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));

  const where: Record<string, unknown> = {};

  // EMPLOYEE видит только свои, ADMIN/APPROVER — все в своих юнитах
  if (auth.role === 'EMPLOYEE') {
    where.userId = auth.userId;
  } else {
    // Админ видит платежи юнитов, к которым привязан
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
      },
    }),
    prisma.payment.count({ where }),
  ]);

  return Response.json({
    payments: payments.map((p) => ({
      ...p,
      amount: Number(p.amount),
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

  const { unitId, adeskCategoryId, adeskProjectId, adeskContractorId, amount, date, description, cardNote } = body;

  if (!unitId || !adeskCategoryId || !amount || !date) {
    return badRequest('unitId, adeskCategoryId, amount, date are required');
  }

  // Проверяем доступ к юниту
  const hasAccess = await prisma.userUnit.findUnique({
    where: { userId_unitId: { userId: auth.userId, unitId: Number(unitId) } },
  });
  if (!hasAccess) {
    return Response.json({ error: 'No access to this unit' }, { status: 403 });
  }

  // Снэпшоты имён
  let contractorNameSnapshot: string | null = null;
  if (adeskContractorId) {
    const cached = await prisma.contractorCache.findUnique({
      where: { adeskId: Number(adeskContractorId) },
    });
    contractorNameSnapshot = cached?.name || null;
  }

  let projectNameSnapshot: string | null = null;
  if (adeskProjectId) {
    const cached = await prisma.projectCache.findUnique({
      where: { adeskId: Number(adeskProjectId) },
    });
    projectNameSnapshot = cached?.name || null;
  }

  const payment = await prisma.payment.create({
    data: {
      id: globalThis.crypto.randomUUID(),
      userId: auth.userId,
      unitId: Number(unitId),
      adeskCategoryId: Number(adeskCategoryId),
      adeskProjectId: adeskProjectId ? Number(adeskProjectId) : null,
      adeskContractorId: adeskContractorId ? Number(adeskContractorId) : null,
      contractorNameSnapshot,
      projectNameSnapshot,
      amount: Number(amount),
      date: new Date(date),
      description: description || null,
      cardNote: cardNote || null,
      status: 'PENDING_RETRO',
    },
  });

  // Получаем названия для сообщения в группу
  const unit = await prisma.unit.findUnique({ where: { id: Number(unitId) } });
  const category = await prisma.categoryCache.findUnique({ where: { adeskId: Number(adeskCategoryId) } });

  const lines = [
    `<b>${unit?.name ?? 'Юнит'}</b>`,
    category?.name ?? 'Статья',
    projectNameSnapshot ? `📁 ${projectNameSnapshot}` : '',
    `${Number(amount).toLocaleString('ru-RU')} ₽`,
    cardNote || description || '',
  ].filter(Boolean);

  sendToGroup(lines.join('\n')).catch(() => {});

  // Запускаем ретро-матчинг асинхронно (не блокируем ответ)
  processRetroMatch(payment.id).catch((err) => {
    console.error(`Retro-match failed for payment ${payment.id}:`, err);
  });

  return Response.json(
    { payment: { ...payment, amount: Number(payment.amount) } },
    { status: 201 },
  );
}
