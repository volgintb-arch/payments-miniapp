// src/lib/date.ts
// Локальная сегодняшняя дата в формате YYYY-MM-DD. new Date().toISOString()
// даёт дату в UTC: для РФ (UTC+3…+12) до утра это «вчера», и форма
// преселектила вчерашний день — а для наличных эта дата уходит в Adesk на
// не тот банковский день, для карт сдвигает окно матча и дедуп-ключ.
export function todayLocalIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
