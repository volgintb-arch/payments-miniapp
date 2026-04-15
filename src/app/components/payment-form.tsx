'use client';

import { useEffect, useState, useRef } from 'react';
import { apiFetch } from '@/lib/hooks/use-api';

type Unit = { id: number; name: string };
type CategoryGroup = {
  groupId: number;
  groupName: string;
  categories: { id: number; name: string }[];
};
type Project = { id: number; name: string };
type Contractor = { id: number; name: string };

// Все категории в плоский список для поиска
function flattenCategories(groups: CategoryGroup[]) {
  const result: { id: number; name: string; groupName: string }[] = [];
  for (const g of groups) {
    for (const c of g.categories) {
      result.push({ id: c.id, name: c.name, groupName: g.groupName });
    }
  }
  return result;
}

export function PaymentForm({ onSuccess, chatId }: { onSuccess: () => void; chatId?: string | null }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitId, setUnitId] = useState<number | null>(null);
  const [groups, setGroups] = useState<CategoryGroup[]>([]);

  // Статья — поиск
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryQuery, setCategoryQuery] = useState('');
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const categoryRef = useRef<HTMLDivElement>(null);

  // Проект — поиск
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectName, setProjectName] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const projectRef = useRef<HTMLDivElement>(null);

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [description, setDescription] = useState('');
  const [cardNote, setCardNote] = useState('');

  const [contractorQuery, setContractorQuery] = useState('');
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [contractorId, setContractorId] = useState<number | null>(null);
  const [contractorName, setContractorName] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Закрытие выпадающих при клике вне
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

  // Загрузка юнитов
  useEffect(() => {
    apiFetch<{ units: Unit[] }>('/api/units').then((res) => {
      setUnits(res.units);
      if (res.units.length === 1) setUnitId(res.units[0].id);
    });
  }, []);

  // Загрузка категорий при смене юнита
  useEffect(() => {
    if (!unitId) {
      setGroups([]);
      return;
    }
    apiFetch<{ groups: CategoryGroup[] }>(`/api/categories?unitId=${unitId}`).then(
      (res) => {
        setGroups(res.groups);
        setCategoryId(null);
        setCategoryName('');
        setCategoryQuery('');
        setProjectId(null);
        setProjectName('');
        setProjectQuery('');
      },
    );
  }, [unitId]);

  // Поиск проектов с debounce
  useEffect(() => {
    if (!unitId) {
      setProjects([]);
      return;
    }
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ unitId: String(unitId) });
      if (projectQuery.length >= 2) params.set('q', projectQuery);
      apiFetch<{ projects: Project[] }>(`/api/projects?${params}`).then(
        (res) => setProjects(res.projects),
      );
    }, projectQuery.length >= 2 ? 300 : 0);
    return () => clearTimeout(timer);
  }, [unitId, projectQuery]);

  // Поиск контрагентов с debounce
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

  // Фильтрация категорий по запросу (локально)
  const allCategories = flattenCategories(groups);
  const filteredCategories = categoryQuery.length >= 1
    ? allCategories.filter((c) =>
        c.name.toLowerCase().includes(categoryQuery.toLowerCase()),
      )
    : allCategories;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!unitId || !categoryId || !amount || !date) return;

    setSubmitting(true);
    setError(null);

    try {
      await apiFetch('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          unitId,
          adeskCategoryId: categoryId,
          adeskProjectId: projectId || undefined,
          adeskContractorId: contractorId,
          amount: parseFloat(amount),
          date,
          description: description || undefined,
          cardNote: cardNote || undefined,
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
  const dropdownClass = 'absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto';
  const dropdownItemClass = 'w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-50 last:border-0';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Юнит */}
      <div>
        <label className="block text-sm font-medium mb-1">Юнит</label>
        <select
          value={unitId ?? ''}
          onChange={(e) => setUnitId(Number(e.target.value) || null)}
          className={inputClass}
          required
        >
          <option value="">Выберите юнит</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
      </div>

      {/* Статья расхода — с поиском */}
      <div ref={categoryRef}>
        <label className="block text-sm font-medium mb-1">Статья расхода</label>
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
              placeholder="Поиск статьи..."
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
                    <div>{c.name}</div>
                    <div className="text-xs text-gray-400">{c.groupName}</div>
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

      {/* Проект — с поиском */}
      {unitId && (
        <div ref={projectRef}>
          <label className="block text-sm font-medium mb-1">Проект (опционально)</label>
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
      )}

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
          placeholder="За что платёж"
        />
      </div>

      {/* Карта/заметка */}
      <div>
        <label className="block text-sm font-medium mb-1">Карта / заметка</label>
        <input
          type="text"
          value={cardNote}
          onChange={(e) => setCardNote(e.target.value)}
          className={inputClass}
          placeholder="Например: Сбер *1234"
        />
      </div>

      {error && <div className="text-sm text-red-500">{error}</div>}

      <button
        type="submit"
        disabled={submitting || !unitId || !categoryId || !amount}
        className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
      >
        {submitting ? 'Отправка...' : 'Создать платёж'}
      </button>
    </form>
  );
}
