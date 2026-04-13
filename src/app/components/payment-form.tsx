'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/hooks/use-api';

type Unit = { id: number; name: string };
type CategoryGroup = {
  groupId: number;
  groupName: string;
  categories: { id: number; name: string }[];
};
type Contractor = { id: number; name: string };

export function PaymentForm({ onSuccess }: { onSuccess: () => void }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitId, setUnitId] = useState<number | null>(null);
  const [groups, setGroups] = useState<CategoryGroup[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(null);
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
      },
    );
  }, [unitId]);

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
          adeskContractorId: contractorId,
          amount: parseFloat(amount),
          date,
          description: description || undefined,
          cardNote: cardNote || undefined,
        }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Юнит */}
      <div>
        <label className="block text-sm font-medium mb-1">Юнит</label>
        <select
          value={unitId ?? ''}
          onChange={(e) => setUnitId(Number(e.target.value) || null)}
          className="w-full border rounded-lg px-3 py-2 text-sm"
          required
        >
          <option value="">Выберите юнит</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
      </div>

      {/* Статья расхода */}
      <div>
        <label className="block text-sm font-medium mb-1">Статья расхода</label>
        <select
          value={categoryId ?? ''}
          onChange={(e) => setCategoryId(Number(e.target.value) || null)}
          className="w-full border rounded-lg px-3 py-2 text-sm"
          required
        >
          <option value="">Выберите статью</option>
          {groups.map((g) => (
            <optgroup key={g.groupId} label={g.groupName}>
              {g.categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </optgroup>
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
          className="w-full border rounded-lg px-3 py-2 text-sm"
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
          className="w-full border rounded-lg px-3 py-2 text-sm"
          required
        />
      </div>

      {/* Контрагент */}
      <div>
        <label className="block text-sm font-medium mb-1">Контрагент (опционально)</label>
        {contractorId ? (
          <div className="flex items-center gap-2">
            <span className="text-sm">{contractorName}</span>
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
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="Начните вводить имя..."
            />
            {contractors.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-40 overflow-y-auto">
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
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
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
          className="w-full border rounded-lg px-3 py-2 text-sm"
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
          className="w-full border rounded-lg px-3 py-2 text-sm"
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
