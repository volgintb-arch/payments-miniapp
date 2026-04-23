'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/hooks/use-api';

type Candidate = {
  txId: number;
  amount: number;
  date: string;
  diff: number;
  description: string;
  bankAccountId: number;
  takenByPaymentId: string | null;
};

type PendingPayment = {
  id: string;
  amount: number;
  date: string;
  description: string | null;
  cardNote: string | null;
  unitName: string;
  userName: string;
  status: 'PENDING_RETRO' | 'NEEDS_REVIEW' | 'ORPHANED';
  retroAttempts: number;
  createdAt: string;
  hasSplits: boolean;
  candidates: Candidate[];
};

export function AdminPending() {
  const [loading, setLoading] = useState(true);
  const [payments, setPayments] = useState<PendingPayment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, Set<number>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ payments: PendingPayment[] }>('/api/admin/pending');
      setPayments(res.payments);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleCandidate = (paymentId: string, txId: number) => {
    setSelected((prev) => {
      const current = new Set(prev[paymentId] || []);
      if (current.has(txId)) current.delete(txId);
      else current.add(txId);
      return { ...prev, [paymentId]: current };
    });
  };

  const match = async (paymentId: string) => {
    const ids = Array.from(selected[paymentId] || []);
    if (ids.length === 0) {
      alert('Выбери минимум одну транзакцию');
      return;
    }
    setBusyId(paymentId);
    try {
      await apiFetch(`/api/admin/manual-match/${paymentId}`, {
        method: 'POST',
        body: JSON.stringify({ transactionIds: ids }),
      });
      await load();
      setSelected((prev) => {
        const next = { ...prev };
        delete next[paymentId];
        return next;
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (paymentId: string) => {
    if (!confirm('Удалить платёж? Это действие необратимо.')) return;
    setBusyId(paymentId);
    try {
      await apiFetch(`/api/admin/pending/${paymentId}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusyId(null);
    }
  };

  const rerunCron = async () => {
    setLoading(true);
    try {
      await apiFetch('/api/admin/pending/rematch', { method: 'POST' });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Загрузка...</div>;
  if (error) return <div className="text-sm text-red-500 py-8 text-center">{error}</div>;

  if (payments.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="text-sm text-gray-500 mb-3">Висящих платежей нет 🎉</div>
        <button
          onClick={rerunCron}
          className="text-xs text-blue-600 underline"
        >
          Запустить матчер
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center mb-2">
        <div className="text-sm text-gray-600">Висящих: {payments.length}</div>
        <button
          onClick={rerunCron}
          className="text-xs px-3 py-1 bg-gray-100 rounded"
        >
          Запустить матчер
        </button>
      </div>
      {payments.map((p) => (
        <div key={p.id} className="border rounded-lg p-3 bg-white overflow-hidden">
          <div className="flex justify-between items-start gap-2 mb-2">
            <div className="flex-1 min-w-0">
              <div className="font-semibold break-words">
                {p.amount.toLocaleString('ru-RU')} ₽ · {p.unitName}
              </div>
              <div className="text-xs text-gray-500 break-words">
                {p.date} · {p.userName} · карта: {p.cardNote || '—'}
              </div>
              {p.description && (
                <div className="text-xs text-gray-700 mt-1 break-words">«{p.description}»</div>
              )}
            </div>
            <div className="text-right shrink-0">
              <span className={`text-[10px] px-2 py-0.5 rounded ${
                p.status === 'ORPHANED'
                  ? 'bg-red-100 text-red-700'
                  : p.status === 'NEEDS_REVIEW'
                    ? 'bg-yellow-100 text-yellow-700'
                    : 'bg-blue-100 text-blue-700'
              }`}>
                {p.status}
              </span>
              <div className="text-[10px] text-gray-400 mt-1">
                попыток: {p.retroAttempts}
              </div>
            </div>
          </div>

          {p.candidates.length === 0 ? (
            <div className="text-xs text-gray-400 italic py-2">
              Нет близких кандидатов в Adesk (±10₽ / ±7 дней)
            </div>
          ) : (
            <div className="space-y-1 mb-2">
              {p.candidates.map((c) => {
                const isSelected = selected[p.id]?.has(c.txId);
                const isTaken = !!c.takenByPaymentId;
                return (
                  <label
                    key={c.txId}
                    className={`flex items-start gap-2 p-1.5 rounded text-xs cursor-pointer ${
                      isTaken ? 'opacity-40' : 'hover:bg-gray-50'
                    } ${isSelected ? 'bg-blue-50' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={!!isSelected}
                      disabled={isTaken}
                      onChange={() => toggleCandidate(p.id, c.txId)}
                      className="mt-0.5 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex gap-2 flex-wrap">
                        <span className="font-medium">
                          {c.amount.toLocaleString('ru-RU')} ₽
                        </span>
                        <span className="text-gray-500">{c.date}</span>
                        {c.diff > 0 && (
                          <span className="text-orange-600">
                            Δ {c.diff.toFixed(2)}₽
                          </span>
                        )}
                        {isTaken && (
                          <span className="text-red-600 text-[10px]">
                            занят
                          </span>
                        )}
                      </div>
                      <div className="text-gray-600 break-all line-clamp-2">
                        {c.description || '—'}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => match(p.id)}
              disabled={busyId === p.id || !selected[p.id]?.size}
              className="flex-1 px-3 py-1.5 bg-blue-600 text-white text-xs rounded disabled:opacity-50"
            >
              Привязать {selected[p.id]?.size ? `(${selected[p.id].size})` : ''}
            </button>
            <button
              onClick={() => remove(p.id)}
              disabled={busyId === p.id}
              className="px-3 py-1.5 bg-red-100 text-red-700 text-xs rounded disabled:opacity-50"
            >
              Удалить
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
