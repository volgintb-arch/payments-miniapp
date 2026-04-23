// PATCH /api/payments/[id]
// Редактирование платежа сотрудником: статья, проект, контрагент, описание, cardNote.
// Сумма/дата/юнит НЕ редактируются (сложно с матчингом).
// Если платёж MATCHED — синхронизируем изменения в Adesk (updateTransaction).
// Сплит-платежи пока не поддерживаются для редактирования через этот эндпоинт.

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, badRequest } from '@/lib/api-helpers';
import { adesk } from '@/lib/adesk/client';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { splits: true },
  });
  if (!payment) return Response.json({ error: 'Not found' }, { status: 404 });

  if (auth.role !== 'ADMIN' && payment.userId !== auth.userId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (payment.splits.length > 0) {
    return badRequest('Редактирование сплит-платежей пока не поддерживается');
  }

  const body = await request.json().catch(() => null);
  if (!body) return badRequest('Invalid JSON');

  const {
    adeskCategoryId,
    adeskProjectId,
    adeskContractorId,
    description,
    cardNote,
  } = body;

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

  const nextCategoryId = adeskCategoryId !== undefined ? Number(adeskCategoryId) : payment.adeskCategoryId;
  const nextProjectId =
    adeskProjectId !== undefined && adeskProjectId !== null && adeskProjectId !== ''
      ? Number(adeskProjectId)
      : payment.adeskProjectId;
  const nextContractorId =
    adeskContractorId === null || adeskContractorId === ''
      ? null
      : adeskContractorId !== undefined
        ? Number(adeskContractorId)
        : payment.adeskContractorId;
  const nextDescription = description !== undefined ? (description || null) : payment.description;
  const nextCardNote = cardNote !== undefined ? (cardNote || null) : payment.cardNote;

  if (!nextProjectId) return badRequest('Выберите проект');
  if (!nextDescription || !String(nextDescription).trim()) return badRequest('Заполните описание');
  if (payment.paymentMethod === 'card' && (!nextCardNote || !String(nextCardNote).trim())) {
    return badRequest('Заполните поле «Карта / заметка»');
  }

  const contractorNameSnapshot = await getContractorName(nextContractorId);
  const projectNameSnapshot = await getProjectName(nextProjectId);

  // Если платёж уже привязан к транзакции в Adesk — обновим транзакцию
  if (payment.status === 'MATCHED' && payment.adeskConfirmedTransactionId) {
    try {
      await adesk.updateTransaction(payment.adeskConfirmedTransactionId, {
        categoryId: nextCategoryId,
        projectId: nextProjectId ?? undefined,
        contractorId: nextContractorId ?? undefined,
        description: nextDescription ?? undefined,
      });
    } catch (err) {
      console.error(`[payment edit] Adesk update failed for ${id}:`, err);
      return Response.json(
        { error: 'Не удалось обновить транзакцию в Adesk: ' + (err instanceof Error ? err.message : 'unknown') },
        { status: 502 },
      );
    }
  }

  const updated = await prisma.payment.update({
    where: { id },
    data: {
      adeskCategoryId: nextCategoryId,
      adeskProjectId: nextProjectId,
      adeskContractorId: nextContractorId,
      contractorNameSnapshot,
      projectNameSnapshot,
      description: nextDescription,
      cardNote: nextCardNote,
    },
  });

  return Response.json({ payment: { ...updated, amount: Number(updated.amount) } });
}
