'use client';

import { useEffect, useState, useRef } from 'react';
import { apiFetch } from '@/lib/hooks/use-api';

type CategoryGroup = {
  groupId: number;
  groupName: string;
  categories: { id: number; name: string }[];
};
type Project = { id: number; name: string };
type Contractor = { id: number; name: string };
type Safe = { id: number; name: string };

function flattenCategories(groups: CategoryGroup[]) {
  const result: { id: number; name: string }[] = [];
  for (const g of groups) {
    for (const c of g.categories) {
      result.push({ id: c.id, name: c.name });
    }
  }
  return result;
}

export function IncomeForm({ onSuccess, chatId }: { onSuccess: () => void; chatId?: string | null }) {
  const [safes, setSafes] = useState<Safe[]>([]);
  const [safeId, setSafeId] = useState<number | null>(null);

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

  const [contractorQuery, setContractorQuery] = useState('');
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [contractorId, setContractorId] = useState<number | null>(null);
  const [contractorName, setContractorName] = useState('');

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [description, setDescription] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    apiFetch<{ safes: Safe[] }>('/api/safes').then((res) => setSafes(res.safes));
    apiFetch<{ groups: CategoryGroup[] }>('/api/categories?direction=income').then((res) =>
      setGroups(res.groups),
    );
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (projectQuery.length >= 2) params.set('q', projectQuery);
      apiFetch<{ projects: Project[] }>(`/api/projects?${params}`).then((res) =>
        setProjects(res.projects),
      );
    }, projectQuery.length >= 2 ? 300 : 0);
    return () => clearTimeout(timer);
  }, [projectQuery]);

  useEffect(() => {
    if (contractorQuery.length < 2) {
      setContractors([]);
      return;
    }
    const timer = setTimeout(() => {
      apiFetch<{ contractors: Contractor[] }>(
        `/api/contractors?q=${encodeURIComponent(contractorQuery)}`,
      ).then((res) => setContractors(res.contractors));
    }, 300);
    return () => clearTimeout(timer);
  }, [contractorQuery]);

  const allCategories = flattenCategories(groups);
  const filteredCategories =
    categoryQuery.length >= 1
      ? allCategories.filter((c) => c.name.toLowerCase().includes(categoryQuery.toLowerCase()))
      : allCategories;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!amount || !date || !safeId || !categoryId) return;
    if (!projectId) {
      setError('Выберите проект');
      return;
    }
    if (!description.trim()) {
      setError('Заполните описание');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await apiFetch('/api/incomes', {
        method: 'POST',
        body: JSON.stringify({
          adeskCategoryId: categoryId,
          adeskProjectId: projectId || undefined,
          adeskContractorId: contractorId || undefined,
          amount: parseFloat(amount),
          date,
          description: description || undefined,
          safeId,
          chatId: chatId || undefined,
        }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass = 'w-full border rounded-lg px-3 py-2 text-sm bg-white';
  const dropdownClass =
    'absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto';
  const dropdownItemClass =
    'w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-50 last:border-0';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Сейф */}
      <div>
        <label className="block text-sm font-medium mb-1">Сейф</label>
        <select
          value={safeId ?? ''}
          onChange={(e) => setSafeId(Number(e.target.value) || null)}
          className={inputClass}
          required
        >
          <option value="">Выберите сейф</option>
          {safes.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* Сумма */}
      <div>
        <label className="block text-sm font-medium mb-1">Сумма (₽)</label>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={inputClass}
          placeholder="0.00"
          required
        />
      </div>

      {/* Дата */}
      <div>
        <label className="block text-sm font-medium mb-1">Дата</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={inputClass}
          required
        />
      </div>

      {/* Статья дохода */}
      <div ref={categoryRef}>
        <label className="block text-sm font-medium mb-1">Статья дохода</label>
        {categoryId ? (
          <div className="flex items-center gap-2 border rounded-lg px-3 py-2">
            <span className="text-sm flex-1">{categoryName}</span>
            <button
              type="button"
              onClick={() => {
                setCategoryId(null);
                setCategoryName('');
                setCategoryQuery('');
              }}
              className="text-xs text-red-500 hover:underline"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="relative">
            <input
              type="text"
              value={categoryQuery}
              onChange={(e) => {
                setCategoryQuery(e.target.value);
                setShowCategoryDropdown(true);
              }}
              onFocus={() => setShowCategoryDropdown(true)}
              className={inputClass}
              placeholder="Поиск статьи дохода..."
            />
            {showCategoryDropdown && filteredCategories.length > 0 && (
              <div className={dropdownClass}>
                {filteredCategories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setCategoryId(c.id);
                      setCategoryName(c.name);
                      setShowCategoryDropdown(false);
                      setCategoryQuery('');
                    }}
                    className={dropdownItemClass}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
            {showCategoryDropdown && filteredCategories.length === 0 && categoryQuery.length >= 1 && (
              <div className={dropdownClass}>
                <div className="px-3 py-2 text-sm text-gray-400">Ничего не найдено</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Проект */}
      <div ref={projectRef}>
        <label className="block text-sm font-medium mb-1">Проект</label>
        {projectId ? (
          <div className="flex items-center gap-2 border rounded-lg px-3 py-2">
            <span className="text-sm flex-1">{projectName}</span>
            <button
              type="button"
              onClick={() => {
                setProjectId(null);
                setProjectName('');
                setProjectQuery('');
              }}
              className="text-xs text-red-500 hover:underline"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="relative">
            <input
              type="text"
              value={projectQuery}
              onChange={(e) => {
                setProjectQuery(e.target.value);
                setShowProjectDropdown(true);
              }}
              onFocus={() => setShowProjectDropdown(true)}
              className={inputClass}
              placeholder="Поиск проекта..."
            />
            {showProjectDropdown && projects.length > 0 && (
              <div className={dropdownClass}>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProjectId(p.id);
                      setProjectName(p.name);
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
            {showProjectDropdown && projects.length === 0 && projectQuery.length >= 2 && (
              <div className={dropdownClass}>
                <div className="px-3 py-2 text-sm text-gray-400">Ничего не найдено</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Контрагент */}
      <div>
        <label className="block text-sm font-medium mb-1">Контрагент (опционально)</label>
        {contractorId ? (
          <div className="flex items-center gap-2 border rounded-lg px-3 py-2">
            <span className="text-sm flex-1">{contractorName}</span>
            <button
              type="button"
              onClick={() => {
                setContractorId(null);
                setContractorName('');
                setContractorQuery('');
              }}
              className="text-xs text-red-500 hover:underline"
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
              placeholder="Начните вводить имя..."
            />
            {contractors.length > 0 && (
              <div className={dropdownClass}>
                {contractors.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setContractorId(c.id);
                      setContractorName(c.name);
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
      </div>

      {/* Описание */}
      <div>
        <label className="block text-sm font-medium mb-1">Описание</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
          placeholder="Откуда приход"
          required
        />
      </div>

      {error && <div className="text-sm text-red-500">{error}</div>}

      <button
        type="submit"
        disabled={submitting || !amount || !safeId || !categoryId || !projectId || !description.trim()}
        className="w-full bg-green-600 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-green-700 transition-colors"
      >
        {submitting ? 'Отправка...' : 'Создать приход'}
      </button>
    </form>
  );
}
