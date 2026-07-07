'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/hooks/use-api';
import { matchesSearch } from '@/lib/search';

type UncategorizedTx = {
  txId: number;
  amount: number;
  date: string; // "DD.MM.YYYY"
  description: string;
  isCard: boolean;
  bankAccount: {
    id: number;
    name: string;
    legalEntity: string | null;
  };
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

export function AdminUncategorized() {
  const [items, setItems] = useState<UncategorizedTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [openTxId, setOpenTxId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ items: UncategorizedTx[]; days: number; total: number }>(
        `/api/admin/uncategorized?days=${days}`,
      );
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Загрузка...</div>;
  if (error) return <div className="text-sm text-red-500 py-8 text-center">{error}</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-gray-600">
          Неопознанных: {items.length}
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
            onClick={load}
            className="text-xs px-3 py-1 bg-gray-100 rounded"
          >
            Обновить
          </button>
        </div>
      </div>

      {items.length === 0 && (
        <div className="text-center py-8 text-sm text-gray-500">
          Все транзакции разнесены 🎉
        </div>
      )}

      {items.map((tx) => (
        <div key={tx.txId} className="border rounded-lg p-3 bg-white text-sm">
          <div className="flex items-baseline justify-between mb-1">
            <div className="text-lg font-semibold">{tx.amount.toLocaleString('ru-RU')} ₽</div>
            <div className="text-xs text-gray-500">{tx.date}</div>
          </div>
          <div className="text-xs text-gray-600 mb-2">
            {tx.bankAccount.name}
            {tx.bankAccount.legalEntity ? ` · ${tx.bankAccount.legalEntity}` : ''}
          </div>
          <div className="text-xs text-gray-700 mb-3 break-words">
            {tx.description || '—'}
          </div>
          <button
            onClick={() => setOpenTxId(tx.txId)}
            className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            Разнести
          </button>
        </div>
      ))}

      {openTxId !== null && (() => {
        const tx = items.find((t) => t.txId === openTxId);
        if (!tx) return null;
        return (
          <AssignModal
            tx={tx}
            onCancel={() => setOpenTxId(null)}
            onSuccess={() => {
              setOpenTxId(null);
              load();
            }}
          />
        );
      })()}
    </div>
  );
}

function AssignModal({
  tx,
  onCancel,
  onSuccess,
}: {
  tx: UncategorizedTx;
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
    if (!unitId || !categoryId || !projectId) {
      setErr('Заполните юнит, статью и проект');
      return;
    }
    if (!description.trim()) {
      setErr('Введите описание');
      return;
    }

    // DD.MM.YYYY → YYYY-MM-DD (для сохранения в Payment.date)
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(tx.date);
    const dateIso = m ? `${m[3]}-${m[2]}-${m[1]}` : new Date().toISOString().split('T')[0];

    setSubmitting(true);
    try {
      await apiFetch(`/api/admin/uncategorized/${tx.txId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          unitId,
          adeskCategoryId: categoryId,
          adeskProjectId: projectId,
          adeskContractorId: contractorId || undefined,
          description: description.trim(),
          bankAccountId: tx.bankAccount.id,
          dateIso,
          amount: tx.amount,
          txDescription: tx.description,
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

      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className={inputClass}
        placeholder="Описание"
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
