'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/hooks/use-api';
import { EditPaymentModal } from './edit-payment-modal';

type Payment = {
  id: string;
  amount: number;
  date: string;
  description: string | null;
  cardNote: string | null;
  status: string;
  paymentMethod: string;
  unitId: number;
  adeskCategoryId: number;
  adeskProjectId: number | null;
  adeskContractorId: number | null;
  contractorNameSnapshot: string | null;
  projectNameSnapshot: string | null;
  createdAt: string;
  user: { firstName: string; lastName: string | null; telegramUsername: string | null };
  unit: { name: string };
  splits: Array<{ id: string }>;
};

type Income = {
  id: string;
  amount: number;
  date: string;
  description: string | null;
  status: string;
  projectNameSnapshot: string | null;
  contractorNameSnapshot: string | null;
  createdAt: string;
  user: { firstName: string; lastName: string | null; telegramUsername: string | null };
};

function authorTag(u: { firstName: string; lastName: string | null; telegramUsername: string | null }) {
  if (u.telegramUsername) return `@${u.telegramUsername}`;
  return `${u.firstName} ${u.lastName ?? ''}`.trim();
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  PENDING_RETRO: { label: 'Поиск', color: 'bg-yellow-100 text-yellow-800' },
  MATCHED: { label: 'Сопоставлен', color: 'bg-green-100 text-green-800' },
  NEEDS_REVIEW: { label: 'Проверка', color: 'bg-orange-100 text-orange-800' },
  ORPHANED: { label: 'Не найден', color: 'bg-red-100 text-red-800' },
  CANCELLED: { label: 'Отменён', color: 'bg-gray-100 text-gray-800' },
  PENDING: { label: 'Ожидает', color: 'bg-yellow-100 text-yellow-800' },
  FAILED: { label: 'Ошибка', color: 'bg-red-100 text-red-800' },
};

export function PaymentList() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [editing, setEditing] = useState<Payment | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ payments: Payment[]; pagination: { pages: number } }>(
        `/api/payments?page=${page}&limit=20`,
      ),
      apiFetch<{ incomes: Income[] }>(`/api/incomes?limit=20`),
    ])
      .then(([pRes, iRes]) => {
        setPayments(pRes.payments);
        setIncomes(iRes.incomes || []);
        setTotalPages(pRes.pagination.pages);
      })
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="text-center text-gray-500 py-8">Загрузка...</div>;
  }

  if (payments.length === 0 && incomes.length === 0) {
    return <div className="text-center text-gray-500 py-8">Платежей пока нет</div>;
  }

  return (
    <div className="space-y-3">
      {incomes.length > 0 && (
        <>
          <div className="text-xs font-medium text-green-700">⬆️ Приходы</div>
          {incomes.map((i) => {
            const st = STATUS_LABELS[i.status] ?? { label: i.status, color: 'bg-gray-100 text-gray-800' };
            return (
              <div key={i.id} className="border border-green-200 rounded-lg p-3 bg-green-50 overflow-hidden">
                <div className="flex items-center justify-between mb-1 gap-2">
                  <span className="font-medium text-sm break-words">
                    +{i.amount.toLocaleString('ru-RU')} ₽
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${st.color}`}>
                    {st.label}
                  </span>
                </div>
                <div className="text-xs text-gray-500 space-y-0.5 break-words">
                  <div>{new Date(i.date).toLocaleDateString('ru-RU')} · {authorTag(i.user)}</div>
                  {i.description && <div>{i.description}</div>}
                  {i.projectNameSnapshot && <div>Проект: {i.projectNameSnapshot}</div>}
                  {i.contractorNameSnapshot && <div>Контрагент: {i.contractorNameSnapshot}</div>}
                </div>
              </div>
            );
          })}
          {payments.length > 0 && <div className="text-xs font-medium text-gray-600 pt-2">Расходы</div>}
        </>
      )}

      {payments.map((p) => {
        const st = STATUS_LABELS[p.status] ?? { label: p.status, color: 'bg-gray-100 text-gray-800' };
        const canEdit = p.splits.length === 0 && p.status !== 'CANCELLED';
        return (
          <div key={p.id} className="border rounded-lg p-3 overflow-hidden">
            <div className="flex items-center justify-between mb-1 gap-2">
              <span className="font-medium text-sm break-words">
                {p.amount.toLocaleString('ru-RU')} ₽
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${st.color}`}>
                {st.label}
              </span>
            </div>
            <div className="text-xs text-gray-500 space-y-0.5 break-words">
              <div>{p.unit.name} · {new Date(p.date).toLocaleDateString('ru-RU')} · {authorTag(p.user)}</div>
              {p.description && <div>{p.description}</div>}
              {p.projectNameSnapshot && <div>Проект: {p.projectNameSnapshot}</div>}
              {p.contractorNameSnapshot && <div>Контрагент: {p.contractorNameSnapshot}</div>}
              {p.cardNote && <div>Карта: {p.cardNote}</div>}
            </div>
            {canEdit && (
              <div className="mt-2">
                <button
                  onClick={() => setEditing(p)}
                  className="text-xs text-blue-600 hover:underline"
                >
                  ✎ Редактировать
                </button>
              </div>
            )}
          </div>
        );
      })}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 pt-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 text-sm border rounded disabled:opacity-30"
          >
            ←
          </button>
          <span className="px-3 py-1 text-sm">{page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1 text-sm border rounded disabled:opacity-30"
          >
            →
          </button>
        </div>
      )}

      {editing && (
        <EditPaymentModal
          payment={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}
