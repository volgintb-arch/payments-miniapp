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

type EditablePayment = {
  id: string;
  unitId: number;
  paymentMethod: string;
  adeskCategoryId: number;
  adeskProjectId: number | null;
  adeskContractorId: number | null;
  projectNameSnapshot: string | null;
  contractorNameSnapshot: string | null;
  description: string | null;
  cardNote: string | null;
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

export function EditPaymentModal({
  payment,
  onClose,
  onSaved,
}: {
  payment: EditablePayment;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [groups, setGroups] = useState<CategoryGroup[]>([]);
  const [categoryId, setCategoryId] = useState<number>(payment.adeskCategoryId);
  const [categoryName, setCategoryName] = useState('');
  const [categoryQuery, setCategoryQuery] = useState('');
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const categoryRef = useRef<HTMLDivElement>(null);

  const [projectId, setProjectId] = useState<number | null>(payment.adeskProjectId);
  const [projectName, setProjectName] = useState(payment.projectNameSnapshot || '');
  const [projectQuery, setProjectQuery] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const projectRef = useRef<HTMLDivElement>(null);

  const [contractorQuery, setContractorQuery] = useState('');
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [contractorId, setContractorId] = useState<number | null>(payment.adeskContractorId);
  const [contractorName, setContractorName] = useState(payment.contractorNameSnapshot || '');

  const [description, setDescription] = useState(payment.description || '');
  const [cardNote, setCardNote] = useState(payment.cardNote || '');

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
    apiFetch<{ groups: CategoryGroup[] }>(`/api/categories?unitId=${payment.unitId}`).then(
      (res) => {
        setGroups(res.groups);
        for (const g of res.groups) {
          for (const c of g.categories) {
            if (c.id === payment.adeskCategoryId) {
              setCategoryName(c.name);
              return;
            }
          }
        }
      },
    );
  }, [payment.unitId, payment.adeskCategoryId]);

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

  async function handleSave() {
    if (!categoryId) {
      setError('Выберите статью');
      return;
    }
    if (!projectId) {
      setError('Выберите проект');
      return;
    }
    if (!description.trim()) {
      setError('Заполните описание');
      return;
    }
    if (payment.paymentMethod === 'card' && !cardNote.trim()) {
      setError('Заполните поле «Карта / заметка»');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/payments/${payment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          adeskCategoryId: categoryId,
          adeskProjectId: projectId,
          adeskContractorId: contractorId,
          description: description || null,
          cardNote: cardNote || null,
        }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
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
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center overflow-y-auto py-6 px-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-4 space-y-3">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">Редактировать платёж</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div ref={categoryRef}>
          <label className="block text-sm font-medium mb-1">Статья расхода</label>
          {categoryName && !showCategoryDropdown ? (
            <div className="flex items-center gap-2 border rounded-lg px-3 py-2">
              <span className="text-sm flex-1">{categoryName}</span>
              <button
                type="button"
                onClick={() => {
                  setCategoryName('');
                  setCategoryQuery('');
                  setShowCategoryDropdown(true);
                }}
                className="text-xs text-blue-500 hover:underline"
              >
                Изменить
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
                autoFocus
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
            </div>
          )}
        </div>

        <div ref={projectRef}>
          <label className="block text-sm font-medium mb-1">Проект</label>
          {projectName ? (
            <div className="flex items-center gap-2 border rounded-lg px-3 py-2">
              <span className="text-sm flex-1">{projectName}</span>
              <button
                type="button"
                onClick={() => {
                  setProjectId(null);
                  setProjectName('');
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
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Контрагент</label>
          {contractorName ? (
            <div className="flex items-center gap-2 border rounded-lg px-3 py-2">
              <span className="text-sm flex-1">{contractorName}</span>
              <button
                type="button"
                onClick={() => {
                  setContractorId(null);
                  setContractorName('');
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
                placeholder="Поиск..."
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

        {payment.paymentMethod === 'card' && (
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

        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={
              submitting ||
              !categoryId ||
              !projectId ||
              !description.trim() ||
              (payment.paymentMethod === 'card' && !cardNote.trim())
            }
            className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Сохранение...' : 'Сохранить'}
          </button>
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
