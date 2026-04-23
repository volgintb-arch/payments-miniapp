// GET  /api/incomes — список приходов текущего пользователя
// POST /api/incomes — создание прихода наличных + запись в Adesk

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, badRequest } from '@/lib/api-helpers';
import { adesk } from '@/lib/adesk/client';
import { sendToGroup } from '@/lib/telegram';

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const page = Math.max(1, Number(request.nextUrl.searchParams.get('page')) || 1);
  const limit = Math.min(50, Math.max(1, Number(request.nextUrl.searchParams.get('limit')) || 20));

  const where: Record<string, unknown> =
    auth.role === 'EMPLOYEE' ? { userId: auth.userId } : {};

  const [incomes, total] = await Promise.all([
    prisma.cashIncome.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { user: { select: { firstName: true, lastName: true } } },
    }),
    prisma.cashIncome.count({ where }),
  ]);

  return Response.json({
    incomes: incomes.map((i) => ({ ...i, amount: Number(i.amount) })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => null);
  if (!body) return badRequest('Invalid JSON');

  const {
    adeskCategoryId, adeskProjectId, adeskContractorId,
    amount, date, description, safeId, chatId,
  } = body;

  if (!amount || !date) return badRequest('amount, date are required');
  if (!safeId) return badRequest('safeId is required');
  if (!adeskCategoryId) return badRequest('adeskCategoryId is required');
  if (!adeskProjectId) return badRequest('Выберите проект');
  if (!description || !String(description).trim()) return badRequest('Заполните описание');

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

  const projectNameSnapshot = await getProjectName(adeskProjectId ? Number(adeskProjectId) : null);
  const contractorNameSnapshot = await getContractorName(adeskContractorId ? Number(adeskContractorId) : null);

  const income = await prisma.cashIncome.create({
    data: {
      id: globalThis.crypto.randomUUID(),
      userId: auth.userId,
      adeskCategoryId: Number(adeskCategoryId),
      adeskProjectId: adeskProjectId ? Number(adeskProjectId) : null,
      adeskContractorId: adeskContractorId ? Number(adeskContractorId) : null,
      projectNameSnapshot,
      contractorNameSnapshot,
      amount: Number(amount),
      date: new Date(date),
      description: description || null,
      adeskSafeId: Number(safeId),
      status: 'PENDING',
    },
  });

  const category = await prisma.categoryCache.findUnique({ where: { adeskId: Number(adeskCategoryId) } });
  const tgText = [
    '⬆️ ПРИХОД',
    category?.name ?? 'Доход',
    projectNameSnapshot || '',
    `${Number(amount).toLocaleString('ru-RU')} ₽`,
    description || '',
  ].filter(Boolean).join(' / ');

  sendToGroup(tgText, chatId || undefined).catch(() => {});

  try {
    const res = await adesk.createTransaction({
      amount: Number(amount),
      date,
      type: 'income',
      bankAccountId: Number(safeId),
      categoryId: Number(adeskCategoryId),
      projectId: adeskProjectId ? Number(adeskProjectId) : undefined,
      contractorId: adeskContractorId ? Number(adeskContractorId) : undefined,
      description: description || undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resAny = res as any;
    const txId = resAny.transaction?.id || resAny.transactions?.[0]?.id || resAny.id;
    if (txId) {
      await prisma.cashIncome.update({
        where: { id: income.id },
        data: { status: 'MATCHED', adeskTransactionId: txId, matchedAt: new Date() },
      });
    } else {
      console.error(`[income] Adesk did not return id for ${income.id}`, res);
      await prisma.cashIncome.update({
        where: { id: income.id },
        data: { status: 'FAILED' },
      });
    }
  } catch (err) {
    console.error(`[income] Adesk createTransaction failed for ${income.id}:`, err);
    await prisma.cashIncome.update({
      where: { id: income.id },
      data: { status: 'FAILED' },
    });
  }

  return Response.json(
    { income: { ...income, amount: Number(income.amount) } },
    { status: 201 },
  );
}
