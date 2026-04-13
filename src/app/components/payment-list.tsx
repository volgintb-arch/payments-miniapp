'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/hooks/use-api';

type Payment = {
  id: string;
  amount: number;
  date: string;
  description: string | null;
  cardNote: string | null;
  status: string;
  contractorNameSnapshot: string | null;
  createdAt: string;
  user: { firstName: string; lastName: string | null };
  unit: { name: string };
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  PENDING_RETRO: { label: 'Поиск', color: 'bg-yellow-100 text-yellow-800' },
  MATCHED: { label: 'Сопоставлен', color: 'bg-green-100 text-green-800' },
  NEEDS_REVIEW: { label: 'Проверка', color: 'bg-orange-100 text-orange-800' },
  ORPHANED: { label: 'Не найден', color: 'bg-red-100 text-red-800' },
  CANCELLED: { label: 'Отменён', color: 'bg-gray-100 text-gray-800' },
};

export function PaymentList() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    setLoading(true);
    apiFetch<{ payments: Payment[]; pagination: { pages: number } }>(
      `/api/payments?page=${page}&limit=20`,
    )
      .then((res) => {
        setPayments(res.payments);
        setTotalPages(res.pagination.pages);
      })
      .finally(() => setLoading(false));
  }, [page]);

  if (loading) {
    return <div className="text-center text-gray-500 py-8">Загрузка...</div>;
  }

  if (payments.length === 0) {
    return <div className="text-center text-gray-500 py-8">Платежей пока нет</div>;
  }

  return (
    <div className="space-y-3">
      {payments.map((p) => {
        const st = STATUS_LABELS[p.status] ?? { label: p.status, color: 'bg-gray-100 text-gray-800' };
        return (
          <div key={p.id} className="border rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-sm">
                {p.amount.toLocaleString('ru-RU')} ₽
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${st.color}`}>
                {st.label}
              </span>
            </div>
            <div className="text-xs text-gray-500 space-y-0.5">
              <div>{p.unit.name} · {new Date(p.date).toLocaleDateString('ru-RU')}</div>
              {p.description && <div>{p.description}</div>}
              {p.contractorNameSnapshot && <div>Контрагент: {p.contractorNameSnapshot}</div>}
              {p.cardNote && <div>Карта: {p.cardNote}</div>}
            </div>
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
    </div>
  );
}
