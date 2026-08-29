// src/lib/safes.ts
// Единый источник списка сейфов (наличных счетов Adesk). Раньше он был
// захардкожен только в /api/safes, а POST /api/payments и /api/incomes писали
// в Adesk любой присланный safeId — можно было провести операцию на любом
// расчётном счёте компании. Теперь роуты валидируют safeId по этому списку.

export const SAFES: ReadonlyArray<{ id: number; name: string }> = [
  { id: 194856, name: 'Урбан наличка' },
  { id: 206948, name: 'Наличка Детская' },
];

export function isValidSafeId(id: number): boolean {
  return SAFES.some((s) => s.id === id);
}
