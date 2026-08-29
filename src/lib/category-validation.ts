// src/lib/category-validation.ts
// Серверная сверка выбранной статьи (adeskCategoryId) с юнитом и типом.
// Раньше сервер доверял клиенту: можно было передать статью чужого юнита,
// доходную статью для расхода или несуществующий id — она уходила в Adesk.
// Эти проверки повторяют ровно то, что отдают GET /api/categories.
//
// CategoryCache.type: 1 = доход, 2 = расход.

import { prisma } from './db';

// Статья расхода, доступная в выбранном юните: существует, не архивна,
// type=2 (расход), и её группа входит в UnitGroup юнита.
export async function isValidExpenseCategoryForUnit(
  categoryId: number,
  unitId: number,
): Promise<boolean> {
  if (!Number.isInteger(categoryId) || categoryId <= 0) return false;
  const cat = await prisma.categoryCache.findUnique({ where: { adeskId: categoryId } });
  if (!cat || cat.isArchived || cat.type !== 2 || cat.adeskGroupId == null) return false;
  const inGroup = await prisma.unitGroup.findFirst({
    where: { unitId, adeskGroupId: cat.adeskGroupId },
    select: { adeskGroupId: true },
  });
  return !!inGroup;
}

// Доходная статья: существует, не архивна, type=1. Доходные статьи в этом
// проекте не скоупятся по юниту (см. /api/categories?direction=income).
export async function isValidIncomeCategory(categoryId: number): Promise<boolean> {
  if (!Number.isInteger(categoryId) || categoryId <= 0) return false;
  const cat = await prisma.categoryCache.findUnique({ where: { adeskId: categoryId } });
  return !!cat && !cat.isArchived && cat.type === 1;
}
