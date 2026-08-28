'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/hooks/use-api';
import { matchesSearch } from '@/lib/search';

type UncategorizedTx = {
  txId: number;
  amount: number;
  date: string; // "DD.MM.YYYY"
  description: string;
  isCard: boolean;
  cardSuffix: string | null;
  bankAccount: {
    id: number;
    name: string;
    legalEntity: string | null;
  };
  pendingPayment: {
    id: string;
    userTag: string;
    date: string; // "YYYY-MM-DD"
    description: string | null;
    status: 'PENDING_RETRO' | 'NEEDS_REVIEW' | 'ORPHANED';
  } | null;
};

type Unit = { id: number; name: string };
type CategoryGroup = {
  groupId: number;
  groupName: string;
  categories: { id: number; name: string }[];
};
type Project = { id: number; name: string };
type Contractor = { id: number; name: string };

function flattenCategories(groups: CategoryGroup[]) {
  const out: { id: number; name: string; groupName: string }[] = [];
  for (const g of groups) {
    for (const c of g.categories) out.push({ id: c.id, name: c.name, groupName: g.groupName });
  }
  return out;
}

type Split = {
  id: string;
  unitId: number | null;
  categoryId: number | null;
  categoryName: string;
  projectId: number | null;
  projectName: string;
  contractorId: number | null;
  contractorName: string;
  amount: string;
  description: string;
};

// Список собирается обходом всех банк-счетов в Adesk пачками по 3, с ретраями
// на 429 — на холодном кэше и большом окне это заметно больше дефолтных 30
// секунд apiFetch. Даём запросу 3 минуты: лучше подождать с честной
// подсказкой, чем получить «Сервер не отвечает» на живом запросе.
const LOAD_TIMEOUT_MS = 180_000;

function newSplitId() {
  return Math.random().toString(36).slice(2, 11);
}

export function AdminUncategorized({ chatId }: { chatId?: string | null } = {}) {
  const [items, setItems] = useState<UncategorizedTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [openTxId, setOpenTxId] = useState<number | null>(null);
  const [cardFilter, setCardFilter] = useState('');
  const [amountFilter, setAmountFilter] = useState('');

  const [total, setTotal] = useState(0);
  const [slowHint, setSlowHint] = useState(false);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    setSlowHint(false);
    try {
      const url = `/api/admin/uncategorized?days=${days}${force ? '&nocache=1' : ''}`;
      const res = await apiFetch<{ items: UncategorizedTx[]; days: number; total: number; shown: number }>(
        url,
        { timeoutMs: LOAD_TIMEOUT_MS },
      );
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  // Через 8 секунд ожидания объясняем, почему так долго — иначе человек
  // решает, что вкладка зависла, и уходит. Сброс флага — в load(), чтобы не
  // дёргать setState синхронно в теле эффекта.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setSlowHint(true), 8_000);
    return () => clearTimeout(t);
  }, [loading]);

  // Уникальные cardSuffix из текущей выборки (для чипсов-подсказок).
  const uniqueCardSuffixes = useMemo(() => {
    const set = new Set<string>();
    for (const t of items) if (t.cardSuffix) set.add(t.cardSuffix);
    return Array.from(set).sort();
  }, [items]);

  // Фильтры по карте и по сумме применяются вместе.
  // Сумма — includes-совпадение как строка: «500» находит 500, 500.02, 1500…
  const filteredItems = useMemo(() => {
    return items.filter((t) => {
      if (cardFilter && !t.cardSuffix?.includes(cardFilter)) return false;
      if (amountFilter) {
        const asStr = String(t.amount);
        // Формат в БД — number (2 знака после точки), toString даёт «500» или «500.02».
        // Даём совпадение по префиксу целой части ИЛИ подстроке всей суммы.
        if (!asStr.includes(amountFilter)) return false;
      }
      return true;
    });
  }, [items, cardFilter, amountFilter]);

  if (loading) {
    return (
      <div className="text-sm text-gray-500 py-8 text-center space-y-1">
        <div>Загрузка...</div>
        {slowHint && (
          <div className="text-xs text-gray-400">
            Собираем операции по всем счетам, это может занять до минуты.
          </div>
        )}
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-8 text-center space-y-2">
        <div className="text-sm text-red-500">{error}</div>
        <button onClick={() => load(true)} className="text-xs px-3 py-1 bg-gray-100 rounded">
          Повторить
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-gray-600">
          Неопознанных: {filteredItems.length}
          {(cardFilter || amountFilter) && filteredItems.length !== items.length && (
            <span className="text-xs text-gray-400"> из {items.length}</span>
          )}
          {!cardFilter && !amountFilter && total > items.length && (
            <span className="text-xs text-amber-600 ml-1">
              (показано {items.length} из {total})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Период:</label>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="text-xs border rounded px-2 py-1 bg-white"
          >
            <option value={7}>7 дн</option>
            <option value={30}>30 дн</option>
            <option value={60}>60 дн</option>
            <option value={90}>90 дн</option>
            <option value={180}>180 дн</option>
          </select>
          <button
            onClick={() => load(true)}
            className="text-xs px-3 py-1 bg-gray-100 rounded"
          >
            Обновить
          </button>
        </div>
      </div>

      {/* Фильтры: последние 4 цифры карты + сумма */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <label className="text-xs text-gray-500 shrink-0">Карта:</label>
        <input
          type="text"
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          value={cardFilter}
          onChange={(e) => setCardFilter(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="4 цифры"
          className="text-xs border rounded px-2 py-1 bg-white w-24"
        />
        {cardFilter && (
          <button
            onClick={() => setCardFilter('')}
            className="text-xs text-gray-400 hover:text-gray-600 px-1"
            title="Сбросить"
          >
            ✕
          </button>
        )}

        <label className="text-xs text-gray-500 shrink-0 ml-2">Сумма:</label>
        <input
          type="text"
          inputMode="decimal"
          value={amountFilter}
          onChange={(e) => setAmountFilter(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="напр. 500"
          className="text-xs border rounded px-2 py-1 bg-white w-24"
        />
        {amountFilter && (
          <button
            onClick={() => setAmountFilter('')}
            className="text-xs text-gray-400 hover:text-gray-600 px-1"
            title="Сбросить"
          >
            ✕
          </button>
        )}
      </div>

      {/* Чипсы с найденными в выборке карт */}
      {uniqueCardSuffixes.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {uniqueCardSuffixes.map((s) => (
            <button
              key={s}
              onClick={() => setCardFilter((prev) => (prev === s ? '' : s))}
              className={`text-xs px-2 py-0.5 rounded border ${
                cardFilter === s
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              *{s}
            </button>
          ))}
        </div>
      )}

      {filteredItems.length === 0 && (
        <div className="text-center py-8 text-sm text-gray-500">
          {cardFilter || amountFilter
            ? `Ничего не найдено${cardFilter ? ` по карте *${cardFilter}` : ''}${amountFilter ? ` на сумму ${amountFilter}` : ''}`
            : 'Все транзакции разнесены 🎉'}
        </div>
      )}

      {filteredItems.map((tx) => (
        <div key={tx.txId} className="border rounded-lg p-3 bg-white text-sm">
          <div className="flex items-baseline justify-between mb-1">
            <div className="text-lg font-semibold">{tx.amount.toLocaleString('ru-RU')} ₽</div>
            <div className="text-xs text-gray-500">{tx.date}</div>
          </div>
          <div className="text-xs text-gray-600 mb-2 flex items-center gap-2 flex-wrap">
            <span>{tx.bankAccount.name}{tx.bankAccount.legalEntity ? ` · ${tx.bankAccount.legalEntity}` : ''}</span>
            {tx.cardSuffix && (
              <span className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded border border-blue-200">
                *{tx.cardSuffix}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-700 mb-3 break-words">
            {tx.description || '—'}
          </div>
          {tx.pendingPayment && (
            <div className="mb-2 p-2 border border-amber-300 bg-amber-50 rounded text-xs text-amber-800">
              ⚠️ Уже подан платёж: <b>{tx.pendingPayment.userTag}</b>
              {tx.pendingPayment.description ? ` · «${tx.pendingPayment.description}»` : ''}
              {` · ${tx.pendingPayment.date} · статус ${tx.pendingPayment.status}`}
            </div>
          )}
          <button
            onClick={() => {
              if (tx.pendingPayment) {
                const msg = `Этот платёж уже подал ${tx.pendingPayment.userTag} (${tx.pendingPayment.date}, «${tx.pendingPayment.description ?? '—'}», статус ${tx.pendingPayment.status}).\n\nРазнести всё равно? Это создаст ДУБЛЬ, придётся потом удалять hanging-платёж вручную.`;
                if (!confirm(msg)) return;
              }
              setOpenTxId(tx.txId);
            }}
            className={`w-full py-2 rounded-lg text-sm font-medium text-white ${
              tx.pendingPayment
                ? 'bg-amber-600 hover:bg-amber-700'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {tx.pendingPayment ? 'Разнести (есть подача)' : 'Разнести'}
          </button>
        </div>
      ))}

      {openTxId !== null && (() => {
        const tx = items.find((t) => t.txId === openTxId);
        if (!tx) return null;
        return (
          <AssignModal
            tx={tx}
            chatId={chatId ?? null}
            onCancel={() => setOpenTxId(null)}
            onSuccess={() => {
              // Оптимистично убираем карточку — без полного load(),
              // чтобы скролл остался на месте.
              setItems((prev) => prev.filter((t) => t.txId !== openTxId));
              setTotal((prev) => Math.max(0, prev - 1));
              setOpenTxId(null);
            }}
          />
        );
      })()}
    </div>
  );
}

function AssignModal({
  tx,
  chatId,
  onCancel,
  onSuccess,
}: {
  tx: UncategorizedTx;
  chatId: string | null;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitId, setUnitId] = useState<number | null>(null);
  const [groups, setGroups] = useState<CategoryGroup[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryQuery, setCategoryQuery] = useState('');
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const categoryRef = useRef<HTMLDivElement>(null);

  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectName, setProjectName] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const projectRef = useRef<HTMLDivElement>(null);

  const [contractorId, setContractorId] = useState<number | null>(null);
  const [contractorName, setContractorName] = useState('');
  const [contractorQuery, setContractorQuery] = useState('');
  const [contractors, setContractors] = useState<Contractor[]>([]);

  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Сплиты — если массив не пустой, форма в режиме разбивки.
  const [splits, setSplits] = useState<Split[]>([]);
  const hasSplits = splits.length > 0;
  const splitsTotal = splits.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
  const splitsValid = hasSplits
    && splits.every((s) =>
      s.unitId && s.categoryId && s.projectId && s.description.trim() && parseFloat(s.amount) > 0)
    && Math.abs(splitsTotal - tx.amount) < 0.01;

  function startSplitting() {
    const first: Split = {
      id: newSplitId(),
      unitId, categoryId, categoryName,
      projectId, projectName,
      contractorId, contractorName,
      amount: String(tx.amount),
      description: '',
    };
    const second: Split = {
      id: newSplitId(),
      unitId: null, categoryId: null, categoryName: '',
      projectId: null, projectName: '',
      contractorId: null, contractorName: '',
      amount: '',
      description: '',
    };
    setSplits([first, second]);
  }
  function addSplit() {
    setSplits((prev) => [...prev, {
      id: newSplitId(),
      unitId: null, categoryId: null, categoryName: '',
      projectId: null, projectName: '',
      contractorId: null, contractorName: '',
      amount: '', description: '',
    }]);
  }
  function removeSplit(id: string) {
    const next = splits.filter((s) => s.id !== id);
    if (next.length <= 1) {
      if (next.length === 1) {
        const only = next[0];
        setUnitId(only.unitId);
        setCategoryId(only.categoryId); setCategoryName(only.categoryName);
        setProjectId(only.projectId); setProjectName(only.projectName);
        setContractorId(only.contractorId); setContractorName(only.contractorName);
      }
      setSplits([]);
    } else {
      setSplits(next);
    }
  }
  function updateSplit(id: string, patch: Partial<Split>) {
    setSplits((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  useEffect(() => {
    apiFetch<{ units: Unit[] }>('/api/units').then((res) => {
      setUnits(res.units);
      if (res.units.length === 1) setUnitId(res.units[0].id);
    });
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (categoryRef.current && !categoryRef.current.contains(e.target as Node)) {
        setShowCategoryDropdown(false);
      }
      if (projectRef.current && !projectRef.current.contains(e.target as Node)) {
        setShowProjectDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (!unitId) { setGroups([]); return; }
    apiFetch<{ groups: CategoryGroup[] }>(`/api/categories?unitId=${unitId}`).then((res) => {
      setGroups(res.groups);
      setCategoryId(null); setCategoryName(''); setCategoryQuery('');
      setProjectId(null); setProjectName(''); setProjectQuery('');
    });
  }, [unitId]);

  useEffect(() => {
    if (!unitId) { setProjects([]); return; }
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ unitId: String(unitId) });
      if (projectQuery.length >= 2) params.set('q', projectQuery);
      apiFetch<{ projects: Project[] }>(`/api/projects?${params}`).then((res) => setProjects(res.projects));
    }, projectQuery.length >= 2 ? 300 : 0);
    return () => clearTimeout(timer);
  }, [unitId, projectQuery]);

  useEffect(() => {
    if (contractorQuery.length < 2) { setContractors([]); return; }
    const timer = setTimeout(() => {
      apiFetch<{ contractors: Contractor[] }>(
        `/api/contractors?q=${encodeURIComponent(contractorQuery)}`,
      ).then((res) => setContractors(res.contractors));
    }, 300);
    return () => clearTimeout(timer);
  }, [contractorQuery]);

  const allCategories = flattenCategories(groups);
  const filteredCategories = categoryQuery.length >= 1
    ? allCategories.filter((c) => matchesSearch(c.name, categoryQuery))
    : allCategories;

  async function submit() {
    setErr(null);
    if (!description.trim()) {
      setErr('Введите описание платежа');
      return;
    }
    if (hasSplits) {
      if (!splitsValid) {
        setErr(`Каждый сплит должен содержать юнит, статью, проект, описание и сумму. Сумма (${splitsTotal.toFixed(2)}) должна равняться сумме транзакции (${tx.amount.toFixed(2)}).`);
        return;
      }
    } else {
      if (!unitId || !categoryId || !projectId) {
        setErr('Заполните юнит, статью и проект');
        return;
      }
    }

    // DD.MM.YYYY → YYYY-MM-DD (для сохранения в Payment.date)
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(tx.date);
    const dateIso = m ? `${m[3]}-${m[2]}-${m[1]}` : new Date().toISOString().split('T')[0];

    setSubmitting(true);
    try {
      await apiFetch(`/api/admin/uncategorized/${tx.txId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          description: description.trim(),
          bankAccountId: tx.bankAccount.id,
          dateIso,
          amount: tx.amount,
          txDescription: tx.description,
          chatId: chatId || undefined,
          ...(hasSplits
            ? {
                splits: splits.map((s) => ({
                  unitId: s.unitId,
                  adeskCategoryId: s.categoryId,
                  adeskProjectId: s.projectId,
                  adeskContractorId: s.contractorId || undefined,
                  amount: parseFloat(s.amount),
                  description: s.description,
                })),
              }
            : {
                unitId,
                adeskCategoryId: categoryId,
                adeskProjectId: projectId,
                adeskContractorId: contractorId || undefined,
              }),
        }),
      });
      onSuccess();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass = 'w-full border rounded-lg px-2 py-1.5 text-sm bg-white';
  const dropdownClass = 'absolute z-20 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto';
  const dropdownItemClass = 'w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-50 last:border-0';

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center">
    <div className="bg-white w-full sm:max-w-md sm:rounded-lg rounded-t-lg max-h-[90vh] flex flex-col overflow-hidden">
    <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
      <div>
        <div className="text-base font-semibold">{tx.amount.toLocaleString('ru-RU')} ₽ · {tx.date}</div>
        <div className="text-xs text-gray-500">{tx.bankAccount.name}{tx.bankAccount.legalEntity ? ` · ${tx.bankAccount.legalEntity}` : ''}</div>
      </div>
      <button onClick={onCancel} className="text-gray-400 text-xl leading-none px-2">✕</button>
    </div>
    <div className="px-4 py-3 overflow-y-auto flex-1 space-y-2">
      {!hasSplits ? (
        <>
          <select
            value={unitId ?? ''}
            onChange={(e) => setUnitId(Number(e.target.value) || null)}
            className={inputClass}
          >
            <option value="">Юнит</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>

          <div ref={categoryRef}>
            {categoryId ? (
              <div className="flex items-center gap-2 border rounded-lg px-2 py-1.5 bg-white">
                <span className="text-sm flex-1">{categoryName}</span>
                <button
                  type="button"
                  onClick={() => { setCategoryId(null); setCategoryName(''); }}
                  className="text-xs text-red-500"
                >✕</button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={categoryQuery}
                  disabled={!unitId}
                  onChange={(e) => { setCategoryQuery(e.target.value); setShowCategoryDropdown(true); }}
                  onFocus={() => setShowCategoryDropdown(true)}
                  className={inputClass}
                  placeholder="Статья"
                />
                {showCategoryDropdown && filteredCategories.length > 0 && (
                  <div className={dropdownClass}>
                    {filteredCategories.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setCategoryId(c.id); setCategoryName(c.name);
                          setShowCategoryDropdown(false); setCategoryQuery('');
                        }}
                        className={dropdownItemClass}
                      >
                        <div>{c.name}</div>
                        <div className="text-xs text-gray-400">{c.groupName}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div ref={projectRef}>
            {projectId ? (
              <div className="flex items-center gap-2 border rounded-lg px-2 py-1.5 bg-white">
                <span className="text-sm flex-1">{projectName}</span>
                <button
                  type="button"
                  onClick={() => { setProjectId(null); setProjectName(''); }}
                  className="text-xs text-red-500"
                >✕</button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={projectQuery}
                  disabled={!unitId}
                  onChange={(e) => { setProjectQuery(e.target.value); setShowProjectDropdown(true); }}
                  onFocus={() => setShowProjectDropdown(true)}
                  className={inputClass}
                  placeholder="Проект"
                />
                {showProjectDropdown && projects.length > 0 && (
                  <div className={dropdownClass}>
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setProjectId(p.id); setProjectName(p.name);
                          setShowProjectDropdown(false); setProjectQuery('');
                        }}
                        className={dropdownItemClass}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {contractorId ? (
            <div className="flex items-center gap-2 border rounded-lg px-2 py-1.5 bg-white">
              <span className="text-sm flex-1">{contractorName}</span>
              <button
                type="button"
                onClick={() => { setContractorId(null); setContractorName(''); }}
                className="text-xs text-red-500"
              >✕</button>
            </div>
          ) : (
            <div className="relative">
              <input
                type="text"
                value={contractorQuery}
                onChange={(e) => setContractorQuery(e.target.value)}
                className={inputClass}
                placeholder="Контрагент (опц.)"
              />
              {contractors.length > 0 && (
                <div className={dropdownClass}>
                  {contractors.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setContractorId(c.id); setContractorName(c.name);
                        setContractors([]); setContractorQuery('');
                      }}
                      className={dropdownItemClass}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={startSplitting}
            className="text-xs text-blue-600 hover:underline"
          >
            ＋ Разделить на несколько частей
          </button>
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">Разбивка</label>
            <div className={`text-xs ${Math.abs(splitsTotal - tx.amount) < 0.01 ? 'text-green-600' : 'text-red-500'}`}>
              {splitsTotal.toLocaleString('ru-RU')} / {tx.amount.toLocaleString('ru-RU')} ₽
            </div>
          </div>
          {splits.map((s, idx) => (
            <SplitRow
              key={s.id}
              index={idx}
              split={s}
              units={units}
              onChange={(patch) => updateSplit(s.id, patch)}
              onRemove={() => removeSplit(s.id)}
            />
          ))}
          <button
            type="button"
            onClick={addSplit}
            className="text-xs text-blue-600 hover:underline"
          >
            ＋ Добавить часть
          </button>
        </div>
      )}

      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className={inputClass}
        placeholder="Описание платежа (общее)"
      />

      {err && <div className="text-xs text-red-500">{err}</div>}
    </div>
    <div className="px-4 py-3 border-t flex gap-2 shrink-0 bg-white">
      <button
        onClick={onCancel}
        className="px-4 py-2 bg-gray-100 rounded-lg text-sm"
      >
        Отмена
      </button>
      <button
        onClick={submit}
        disabled={submitting}
        className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-green-700"
      >
        {submitting ? 'Сохранение…' : 'Сохранить'}
      </button>
    </div>
    </div>
    </div>
  );
}

// Отдельная строка сплита — каждая загружает свои категории/проекты/контрагентов
// по выбранному в ней юниту (аналог SplitRow в payment-form.tsx).
function SplitRow({
  index,
  split,
  units,
  onChange,
  onRemove,
}: {
  index: number;
  split: Split;
  units: Unit[];
  onChange: (patch: Partial<Split>) => void;
  onRemove: () => void;
}) {
  const [groups, setGroups] = useState<CategoryGroup[]>([]);
  const [categoryQuery, setCategoryQuery] = useState('');
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const categoryRef = useRef<HTMLDivElement>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectQuery, setProjectQuery] = useState('');
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const projectRef = useRef<HTMLDivElement>(null);

  const [contractorQuery, setContractorQuery] = useState('');
  const [contractors, setContractors] = useState<Contractor[]>([]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (categoryRef.current && !categoryRef.current.contains(e.target as Node)) {
        setShowCategoryDropdown(false);
      }
      if (projectRef.current && !projectRef.current.contains(e.target as Node)) {
        setShowProjectDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (!split.unitId) { setGroups([]); return; }
    apiFetch<{ groups: CategoryGroup[] }>(`/api/categories?unitId=${split.unitId}`).then(
      (res) => setGroups(res.groups),
    );
  }, [split.unitId]);

  useEffect(() => {
    if (!split.unitId) { setProjects([]); return; }
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ unitId: String(split.unitId) });
      if (projectQuery.length >= 2) params.set('q', projectQuery);
      apiFetch<{ projects: Project[] }>(`/api/projects?${params}`).then(
        (res) => setProjects(res.projects),
      );
    }, projectQuery.length >= 2 ? 300 : 0);
    return () => clearTimeout(timer);
  }, [split.unitId, projectQuery]);

  useEffect(() => {
    if (contractorQuery.length < 2) { setContractors([]); return; }
    const timer = setTimeout(() => {
      apiFetch<{ contractors: Contractor[] }>(
        `/api/contractors?q=${encodeURIComponent(contractorQuery)}`,
      ).then((res) => setContractors(res.contractors));
    }, 300);
    return () => clearTimeout(timer);
  }, [contractorQuery]);

  const allCategories = flattenCategories(groups);
  const filteredCategories = categoryQuery.length >= 1
    ? allCategories.filter((c) => matchesSearch(c.name, categoryQuery))
    : allCategories;

  const inputClass = 'w-full border rounded-lg px-2 py-1.5 text-sm bg-white';
  const dropdownClass = 'absolute z-20 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto';
  const dropdownItemClass = 'w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-50 last:border-0';

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-gray-50">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500">Часть #{index + 1}</span>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-red-500 hover:underline"
        >
          Убрать
        </button>
      </div>

      <select
        value={split.unitId ?? ''}
        onChange={(e) => onChange({
          unitId: Number(e.target.value) || null,
          categoryId: null, categoryName: '',
          projectId: null, projectName: '',
        })}
        className={inputClass}
      >
        <option value="">Юнит</option>
        {units.map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
      </select>

      <div ref={categoryRef}>
        {split.categoryId ? (
          <div className="flex items-center gap-2 border rounded-lg px-2 py-1.5 bg-white">
            <span className="text-sm flex-1">{split.categoryName}</span>
            <button
              type="button"
              onClick={() => onChange({ categoryId: null, categoryName: '' })}
              className="text-xs text-red-500"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="relative">
            <input
              type="text"
              value={categoryQuery}
              disabled={!split.unitId}
              onChange={(e) => {
                setCategoryQuery(e.target.value);
                setShowCategoryDropdown(true);
              }}
              onFocus={() => setShowCategoryDropdown(true)}
              className={inputClass}
              placeholder="Статья"
            />
            {showCategoryDropdown && filteredCategories.length > 0 && (
              <div className={dropdownClass}>
                {filteredCategories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      onChange({ categoryId: c.id, categoryName: c.name });
                      setShowCategoryDropdown(false);
                      setCategoryQuery('');
                    }}
                    className={dropdownItemClass}
                  >
                    <div>{c.name}</div>
                    <div className="text-xs text-gray-400">{c.groupName}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div ref={projectRef}>
        {split.projectId ? (
          <div className="flex items-center gap-2 border rounded-lg px-2 py-1.5 bg-white">
            <span className="text-sm flex-1">{split.projectName}</span>
            <button
              type="button"
              onClick={() => onChange({ projectId: null, projectName: '' })}
              className="text-xs text-red-500"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="relative">
            <input
              type="text"
              value={projectQuery}
              disabled={!split.unitId}
              onChange={(e) => {
                setProjectQuery(e.target.value);
                setShowProjectDropdown(true);
              }}
              onFocus={() => setShowProjectDropdown(true)}
              className={inputClass}
              placeholder="Проект"
            />
            {showProjectDropdown && projects.length > 0 && (
              <div className={dropdownClass}>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onChange({ projectId: p.id, projectName: p.name });
                      setShowProjectDropdown(false);
                      setProjectQuery('');
                    }}
                    className={dropdownItemClass}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {split.contractorId ? (
        <div className="flex items-center gap-2 border rounded-lg px-2 py-1.5 bg-white">
          <span className="text-sm flex-1">{split.contractorName}</span>
          <button
            type="button"
            onClick={() => onChange({ contractorId: null, contractorName: '' })}
            className="text-xs text-red-500"
          >
            ✕
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            type="text"
            value={contractorQuery}
            onChange={(e) => setContractorQuery(e.target.value)}
            className={inputClass}
            placeholder="Контрагент (опц.)"
          />
          {contractors.length > 0 && (
            <div className={dropdownClass}>
              {contractors.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onChange({ contractorId: c.id, contractorName: c.name });
                    setContractors([]);
                    setContractorQuery('');
                  }}
                  className={dropdownItemClass}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <input
        type="text"
        value={split.description}
        onChange={(e) => onChange({ description: e.target.value })}
        className={inputClass}
        placeholder="Описание"
      />

      <input
        type="number"
        step="0.01"
        min="0.01"
        value={split.amount}
        onChange={(e) => onChange({ amount: e.target.value })}
        className={inputClass}
        placeholder="Сумма части"
      />
    </div>
  );
}
