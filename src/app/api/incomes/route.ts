// GET  /api/incomes — список приходов текущего пользователя
// POST /api/incomes — создание прихода наличных + запись в Adesk

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, badRequest, parsePositiveAmount } from '@/lib/api-helpers';
import { createTransactionIdempotent } from '@/lib/adesk/idempotent';
import { sendToGroup, sanitizeChatId } from '@/lib/telegram';
import { isValidSafeId } from '@/lib/safes';
import { isValidIncomeCategory } from '@/lib/category-validation';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
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
      include: { user: { select: { firstName: true, lastName: true, telegramUsername: true } } },
    }),
    prisma.cashIncome.count({ where }),
  ]);

  return Response.json({
    incomes: incomes.map((i) => ({ ...i, amount: Number(i.amount) })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => null);
  if (!body) return badRequest('Invalid JSON');

  const {
    adeskCategoryId, adeskProjectId, adeskContractorId,
    amount, date, description, safeId, chatId,
  } = body;

  const amountNum = parsePositiveAmount(amount);
  if (amountNum === null) return badRequest('Сумма должна быть положительным числом');
  if (!date) return badRequest('amount, date are required');
  if (!safeId) return badRequest('safeId is required');
  if (!adeskCategoryId) return badRequest('adeskCategoryId is required');
  if (!adeskProjectId) return badRequest('Выберите проект');
  if (!description || !String(description).trim()) return badRequest('Заполните описание');
  // Сейф — из известного списка (было: любой bankAccount Adesk).
  if (!isValidSafeId(Number(safeId))) return badRequest('Неизвестный сейф');
  // Статья — доходная (type=1), существует. Иначе приход уходил в Adesk с
  // расходной/несуществующей статьёй и ломал отчётность.
  if (!(await isValidIncomeCategory(Number(adeskCategoryId)))) {
    return badRequest('Статья дохода недоступна');
  }

  // Анти-дубль: раньше приходы вообще не защищались, и повторный тап / ретрай
  // после таймаута создавал два прихода в Adesk. Best-effort окно 5 минут по
  // ключевым полям (полную гонку закрыл бы идемпотентный ключ с unique-индексом).
  const recentDup = await prisma.cashIncome.findFirst({
    where: {
      userId: auth.userId,
      amount: Number(amount),
      date: new Date(date),
      adeskSafeId: Number(safeId),
      description: description || null,
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
    select: { id: true },
  });
  if (recentDup) {
    return Response.json(
      { error: 'Похожий приход только что создан. Проверьте историю, прежде чем повторять.' },
      { status: 409 },
    );
  }

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
  const author = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { telegramUsername: true, firstName: true, lastName: true },
  });
  const tag = author
    ? (author.telegramUsername ? `@${author.telegramUsername}` : `${author.firstName} ${author.lastName ?? ''}`.trim())
    : '';
  const tgText = [
    '⬆️ ПРИХОД',
    category?.name ?? 'Доход',
    projectNameSnapshot || '',
    `${Number(amount).toLocaleString('ru-RU')} ₽`,
    description || '',
    tag,
  ].filter(Boolean).join(' / ');

  sendToGroup(tgText, sanitizeChatId(chatId)).catch(() => {});

  // Идемпотентное создание: при таймауте+ретрае найдём уже созданную
  // транзакцию по счёту/дате/сумме/описанию, а не задвоим приход.
  let finalStatus: 'MATCHED' | 'FAILED' = 'FAILED';
  try {
    const { txId } = await createTransactionIdempotent({
      amount: Number(amount),
      date,
      type: 'income',
      bankAccountId: Number(safeId),
      categoryId: Number(adeskCategoryId),
      projectId: adeskProjectId ? Number(adeskProjectId) : undefined,
      contractorId: adeskContractorId ? Number(adeskContractorId) : undefined,
      description: description || undefined,
    });
    if (txId) {
      await prisma.cashIncome.update({
        where: { id: income.id },
        data: { status: 'MATCHED', adeskTransactionId: txId, matchedAt: new Date() },
      });
      finalStatus = 'MATCHED';
    } else {
      console.error(`[income] Adesk did not return id for ${income.id}`);
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

  // Возвращаем актуальный статус, а не stale 'PENDING' из момента создания —
  // иначе пользователь считает, что приход прошёл, хотя он FAILED.
  return Response.json(
    { income: { ...income, amount: Number(income.amount), status: finalStatus } },
    { status: 201 },
  );
}
