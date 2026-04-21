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
type Safe = { id: number; name: string };

type Split = {
  id: string; // локальный uuid для key
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

function flattenCategories(groups: CategoryGroup[]) {
  const result: { id: number; name: string; groupName: string }[] = [];
  for (const g of groups) {
    for (const c of g.categories) {
      result.push({ id: c.id, name: c.name, groupName: g.groupName });
    }
  }
  return result;
}

function newSplitId() {
  return Math.random().toString(36).slice(2, 11);
}

export function PaymentForm({ onSuccess, chatId }: { onSuccess: () => void; chatId?: string | null }) {
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'cash'>('card');

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

  const [safes, setSafes] = useState<Safe[]>([]);
  const [safeId, setSafeId] = useState<number | null>(null);

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

  // Сплиты — если массив не пустой, форма в режиме разбивки
  const [splits, setSplits] = useState<Split[]>([]);

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
    apiFetch<{ units: Unit[] }>('/api/units').then((res) => {
      setUnits(res.units);
      if (res.units.length === 1) setUnitId(res.units[0].id);
    });
  }, []);

  useEffect(() => {
    apiFetch<{ safes: Safe[] }>('/api/safes').then((res) => {
      setSafes(res.safes);
    });
  }, []);

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
  const filteredCategories = categoryQuery.length >= 1
    ? allCategories.filter((c) =>
        c.name.toLowerCase().includes(categoryQuery.toLowerCase()),
      )
    : allCategories;

  const hasSplits = splits.length > 0;
  const splitsTotal = splits.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
  const amountNum = parseFloat(amount) || 0;
  const splitsValid = hasSplits && splits.every((s) => s.unitId && s.categoryId && parseFloat(s.amount) > 0)
    && Math.abs(splitsTotal - amountNum) < 0.01;

  function startSplitting() {
    // Переносим текущие значения в первый сплит
    const first: Split = {
      id: newSplitId(),
      unitId: unitId,
      categoryId: categoryId,
      categoryName: categoryName,
      projectId: projectId,
      projectName: projectName,
      contractorId: contractorId,
      contractorName: contractorName,
      amount: amount,
      description: '',
    };
    const second: Split = {
      id: newSplitId(),
      unitId: null,
      categoryId: null,
      categoryName: '',
      projectId: null,
      projectName: '',
      contractorId: null,
      contractorName: '',
      amount: '',
      description: '',
    };
    setSplits([first, second]);
  }

  function addSplit() {
    setSplits([...splits, {
      id: newSplitId(),
      unitId: null,
      categoryId: null,
      categoryName: '',
      projectId: null,
      projectName: '',
      contractorId: null,
      contractorName: '',
      amount: '',
      description: '',
    }]);
  }

  function removeSplit(id: string) {
    const next = splits.filter((s) => s.id !== id);
    if (next.length <= 1) {
      // Последний сплит — выходим из режима разбивки, восстанавливаем поля платежа
      if (next.length === 1) {
        const only = next[0];
        setUnitId(only.unitId);
        setCategoryId(only.categoryId);
        setCategoryName(only.categoryName);
        setProjectId(only.projectId);
        setProjectName(only.projectName);
        setContractorId(only.contractorId);
        setContractorName(only.contractorName);
      }
      setSplits([]);
    } else {
      setSplits(next);
    }
  }

  function updateSplit(id: string, patch: Partial<Split>) {
    setSplits(splits.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!amount || !date) return;
    if (paymentMethod === 'cash' && !safeId) return;

    if (hasSplits) {
      if (!splitsValid) {
        setError(`Сумма сплитов (${splitsTotal.toFixed(2)}) должна равняться сумме платежа (${amountNum.toFixed(2)}) и все поля заполнены.`);
        return;
      }
    } else {
      if (!unitId || !categoryId) return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await apiFetch('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          unitId: hasSplits ? undefined : unitId,
          adeskCategoryId: hasSplits ? undefined : categoryId,
          adeskProjectId: hasSplits ? undefined : (projectId || undefined),
          adeskContractorId: hasSplits ? undefined : contractorId,
          amount: amountNum,
          date,
          description: description || undefined,
          cardNote: cardNote || undefined,
          chatId: chatId || undefined,
          paymentMethod,
          safeId: paymentMethod === 'cash' ? safeId : undefined,
          splits: hasSplits
            ? splits.map((s) => ({
                unitId: s.unitId,
                adeskCategoryId: s.categoryId,
                adeskProjectId: s.projectId || undefined,
                adeskContractorId: s.contractorId || undefined,
                amount: parseFloat(s.amount),
                description: s.description || undefined,
              }))
            : undefined,
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
  const toggleActiveClass = 'flex-1 py-2 text-sm font-medium rounded-lg transition-colors';

  const submitDisabled =
    submitting ||
    !amount ||
    (paymentMethod === 'cash' && !safeId) ||
    (hasSplits ? !splitsValid : (!unitId || !categoryId));

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Переключатель Карта / Наличные */}
      <div>
        <label className="block text-sm font-medium mb-1">Способ оплаты</label>
        <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
          <button
            type="button"
            onClick={() => setPaymentMethod('card')}
            className={`${toggleActiveClass} ${paymentMethod === 'card' ? 'bg-blue-600 text-white shadow' : 'text-gray-600'}`}
          >
            Карта
          </button>
          <button
            type="button"
            onClick={() => setPaymentMethod('cash')}
            className={`${toggleActiveClass} ${paymentMethod === 'cash' ? 'bg-blue-600 text-white shadow' : 'text-gray-600'}`}
          >
            Наличные
          </button>
        </div>
      </div>

      {paymentMethod === 'cash' && (
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
      )}

      {/* Сумма и Дата — общие для обоих режимов */}
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

      {!hasSplits ? (
        <>
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

          {/* Статья */}
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

          {/* Проект */}
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

          <button
            type="button"
            onClick={startSplitting}
            disabled={!amount}
            className="text-sm text-blue-600 hover:underline disabled:opacity-40 disabled:no-underline"
          >
            ＋ Разделить платёж на несколько частей
          </button>
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Разбивка платежа</label>
            <div className={`text-xs ${Math.abs(splitsTotal - amountNum) < 0.01 ? 'text-green-600' : 'text-red-500'}`}>
              {splitsTotal.toLocaleString('ru-RU')} / {amountNum.toLocaleString('ru-RU')} ₽
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
            className="text-sm text-blue-600 hover:underline"
          >
            ＋ Добавить часть
          </button>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium mb-1">Описание (общее)</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
          placeholder="За что платёж"
        />
      </div>

      {paymentMethod === 'card' && (
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
      )}

      {error && <div className="text-sm text-red-500">{error}</div>}

      <button
        type="submit"
        disabled={submitDisabled}
        className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
      >
        {submitting ? 'Отправка...' : 'Создать платёж'}
      </button>
    </form>
  );
}

// Отдельная строка сплита — каждая загружает свои категории/проекты/контрагентов
// по выбранному в ней юниту.
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
    if (!split.unitId) {
      setGroups([]);
      return;
    }
    apiFetch<{ groups: CategoryGroup[] }>(`/api/categories?unitId=${split.unitId}`).then(
      (res) => setGroups(res.groups),
    );
  }, [split.unitId]);

  useEffect(() => {
    if (!split.unitId) {
      setProjects([]);
      return;
    }
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
  const filteredCategories = categoryQuery.length >= 1
    ? allCategories.filter((c) =>
        c.name.toLowerCase().includes(categoryQuery.toLowerCase()),
      )
    : allCategories;

  const inputClass = 'w-full border rounded-lg px-2 py-1.5 text-sm bg-white';
  const dropdownClass = 'absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto';
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
              placeholder="Проект (опц.)"
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
