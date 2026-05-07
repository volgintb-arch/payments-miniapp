// Утилита нормализации строк для поиска по статьям/проектам/контрагентам.
//
// Учитывает:
//   - регистр (lowercase)
//   - похожие Cyrillic/Latin символы (Р↔P, А↔A, Е↔E, ...). Это решает кейс,
//     когда пользователь вводит «ра» латиницей или статья записана с таким же
//     визуальным написанием, но разной кодировкой.
//   - спец. символы (#, _, *, дефисы, пробелы) — удаляются, чтобы «ра» совпадало с «#РА»

const CYR_TO_LAT: Record<string, string> = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e',
  'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
  'р': 'p', 'с': 'c', 'т': 't', 'х': 'x',
  'у': 'y', 'і': 'i', 'ј': 'j',
};

export function normalizeForSearch(s: string): string {
  const lower = s.toLowerCase();
  let out = '';
  for (const ch of lower) {
    const mapped = CYR_TO_LAT[ch] ?? ch;
    // оставляем только буквы (любого алфавита), цифры
    if (/[\p{L}\p{N}]/u.test(mapped)) {
      out += mapped;
    }
  }
  return out;
}

export function matchesSearch(name: string, query: string): boolean {
  const q = normalizeForSearch(query);
  if (!q) return true;
  return normalizeForSearch(name).includes(q);
}
