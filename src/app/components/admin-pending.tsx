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

type SplitDetail = {
  id: string;
  unitName: string;
  categoryName: string;
  projectName: string | null;
  contractorName: string | null;
  amount: number;
  description: string | null;
};

type PendingPayment = {
  id: string;
  amount: number;
  date: string;
  description: string | null;
  cardNote: string | null;
  unitName: string;
  userName: string;
  userTag: string | null;
  categoryName: string;
  projectName: string | null;
  contractorName: string | null;
  paymentMethod: string;
  adeskSafeId: number | null;
  status: 'PENDING_RETRO' | 'NEEDS_REVIEW' | 'ORPHANED';
  retroAttempts: number;
  createdAt: string;
  hasSplits: boolean;
  splits: SplitDetail[];
  candidates: Candidate[];
};

type PendingIncome = {
  id: string;
  amount: number;
  date: string;
  description: string | null;
  categoryName: string;
  projectName: string;
  contractorName: string;
  userName: string;
  status: 'PENDING' | 'FAILED';
  createdAt: string;
};

type PendingUser = {
  id: string;
  telegramUsername: string | null;
  firstName: string;
  lastName: string | null;
  createdAt: string;
};

export function AdminPending() {
  const [loading, setLoading] = useState(true);
  const [payments, setPayments] = useState<PendingPayment[]>([]);
  const [incomes, setIncomes] = useState<PendingIncome[]>([]);
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [activatingUser, setActivatingUser] = useState<PendingUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, Set<number>>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, uRes] = await Promise.all([
        apiFetch<{ payments: PendingPayment[]; incomes?: PendingIncome[] }>('/api/admin/pending'),
        apiFetch<{ users: PendingUser[] }>('/api/admin/users?pending=1').catch(() => ({ users: [] })),
      ]);
      setPayments(pRes.payments);
      setIncomes(pRes.incomes || []);
      setPendingUsers(uRes.users || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Одиночный выбор: платёж привязывается ровно к одной операции (модель
  // хранит одну привязку, multi-tx приводил к двойному учёту). Повторный клик
  // по выбранной — снимает выбор.
  const toggleCandidate = (paymentId: string, txId: number) => {
    setSelected((prev) => {
      const already = prev[paymentId]?.has(txId);
      return { ...prev, [paymentId]: already ? new Set<number>() : new Set([txId]) };
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
      // Оптимистично убираем карточку из списка — без полного load(),
      // чтобы не сбрасывать скролл.
      setPayments((prev) => prev.filter((p) => p.id !== paymentId));
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
      setPayments((prev) => prev.filter((p) => p.id !== paymentId));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusyId(null);
    }
  };

  // Активация выполняется через модалку с чекбоксами юнитов (см. ActivateUserModal).
  // Здесь оставлена только оптимистичная выдача из списка после успешного submit'а.
  const onActivateSuccess = (userId: string) => {
    setPendingUsers((prev) => prev.filter((u) => u.id !== userId));
    setActivatingUser(null);
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

  const retryIncome = async (incomeId: string) => {
    setBusyId(incomeId);
    try {
      await apiFetch(`/api/admin/incomes/${incomeId}`, { method: 'POST' });
      setIncomes((prev) => prev.filter((i) => i.id !== incomeId));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusyId(null);
    }
  };

  const deleteIncome = async (incomeId: string) => {
    if (!confirm('Удалить приход? Это действие необратимо.')) return;
    setBusyId(incomeId);
    try {
      await apiFetch(`/api/admin/incomes/${incomeId}`, { method: 'DELETE' });
      setIncomes((prev) => prev.filter((i) => i.id !== incomeId));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Загрузка...</div>;
  if (error) return <div className="text-sm text-red-500 py-8 text-center">{error}</div>;

  if (payments.length === 0 && incomes.length === 0 && pendingUsers.length === 0) {
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
        <div className="text-sm text-gray-600">
          Висящих: {payments.length}
          {incomes.length > 0 && ` + приходов: ${incomes.length}`}
        </div>
        <button
          onClick={rerunCron}
          className="text-xs px-3 py-1 bg-gray-100 rounded"
        >
          Запустить матчер
        </button>
      </div>

      {pendingUsers.length > 0 && (
        <div className="space-y-2 mb-4">
          <div className="text-xs font-medium text-amber-700">
            👤 Ожидают активации ({pendingUsers.length})
          </div>
          {pendingUsers.map((u) => {
            const tag = u.telegramUsername ? `@${u.telegramUsername}` : '';
            const fullName = `${u.firstName} ${u.lastName ?? ''}`.trim();
            return (
              <div key={u.id} className="border border-amber-200 rounded-lg p-3 bg-amber-50 flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium break-words">{fullName}</div>
                  {tag && <div className="text-xs text-gray-600">{tag}</div>}
                  <div className="text-[10px] text-gray-400">
                    {new Date(u.createdAt).toLocaleString('ru-RU')}
                  </div>
                </div>
                <button
                  onClick={() => setActivatingUser(u)}
                  className="text-xs px-3 py-1.5 bg-amber-600 text-white rounded"
                >
                  Выдать доступ
                </button>
              </div>
            );
          })}
        </div>
      )}

      {incomes.length > 0 && (
        <div className="space-y-2 mb-4">
          <div className="text-xs font-medium text-green-700">⬆️ Приходы (не ушли в Adesk)</div>
          {incomes.map((i) => (
            <div key={i.id} className="border border-green-200 rounded-lg p-3 bg-green-50 overflow-hidden">
              <div className="flex justify-between items-start gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold break-words">
                    {i.amount.toLocaleString('ru-RU')} ₽ · {i.categoryName}
                  </div>
                  <div className="text-xs text-gray-500 break-words">
                    {i.date} · {i.userName}
                    {i.projectName && ` · ${i.projectName}`}
                    {i.contractorName && ` · ${i.contractorName}`}
                  </div>
                  {i.description && (
                    <div className="text-xs text-gray-700 mt-1 break-words">«{i.description}»</div>
                  )}
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded shrink-0 ${
                  i.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  {i.status}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => retryIncome(i.id)}
                  disabled={busyId === i.id}
                  className="flex-1 px-3 py-1.5 bg-green-600 text-white text-xs rounded disabled:opacity-50"
                >
                  Повторить в Adesk
                </button>
                <button
                  onClick={() => deleteIncome(i.id)}
                  disabled={busyId === i.id}
                  className="px-3 py-1.5 bg-red-100 text-red-700 text-xs rounded disabled:opacity-50"
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {payments.map((p) => (
        <div key={p.id} className="border rounded-lg p-3 bg-white overflow-hidden">
          <button
            type="button"
            onClick={() => toggleExpand(p.id)}
            className="w-full text-left flex justify-between items-start gap-2 mb-2"
          >
            <div className="flex-1 min-w-0">
              <div className="font-semibold break-words flex items-center gap-1">
                <span className="text-gray-400 text-xs">{expanded[p.id] ? '▾' : '▸'}</span>
                {p.amount.toLocaleString('ru-RU')} ₽ · {p.unitName}
              </div>
              <div className="text-xs text-gray-500 break-words">
                {p.date} · {p.userTag || p.userName} · карта: {p.cardNote || '—'}
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
          </button>

          {expanded[p.id] && (
            <div className="mb-2 p-2 bg-gray-50 rounded text-xs space-y-1 break-words">
              <div><span className="text-gray-500">Способ:</span> {p.paymentMethod === 'cash' ? 'Наличные' : 'Карта'}</div>
              <div><span className="text-gray-500">Создан:</span> {new Date(p.createdAt).toLocaleString('ru-RU')}</div>
              <div><span className="text-gray-500">Сотрудник:</span> {p.userName}{p.userTag ? ` (${p.userTag})` : ''}</div>
              {!p.hasSplits ? (
                <>
                  <div><span className="text-gray-500">Юнит:</span> {p.unitName}</div>
                  <div><span className="text-gray-500">Статья:</span> {p.categoryName}</div>
                  <div><span className="text-gray-500">Проект:</span> {p.projectName || '—'}</div>
                  <div><span className="text-gray-500">Контрагент:</span> {p.contractorName || '—'}</div>
                  <div><span className="text-gray-500">Описание:</span> {p.description || '—'}</div>
                  <div><span className="text-gray-500">Карта/заметка:</span> {p.cardNote || '—'}</div>
                </>
              ) : (
                <>
                  <div className="font-medium text-gray-700">Сплиты ({p.splits.length}):</div>
                  {p.splits.map((s, idx) => (
                    <div key={s.id} className="border-l-2 border-blue-200 pl-2 ml-1 space-y-0.5">
                      <div className="font-medium">#{idx + 1} · {s.amount.toLocaleString('ru-RU')} ₽</div>
                      <div><span className="text-gray-500">Юнит:</span> {s.unitName}</div>
                      <div><span className="text-gray-500">Статья:</span> {s.categoryName}</div>
                      <div><span className="text-gray-500">Проект:</span> {s.projectName || '—'}</div>
                      <div><span className="text-gray-500">Контрагент:</span> {s.contractorName || '—'}</div>
                      <div><span className="text-gray-500">Описание:</span> {s.description || '—'}</div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

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

      {activatingUser && (
        <ActivateUserModal
          user={activatingUser}
          onCancel={() => setActivatingUser(null)}
          onSuccess={onActivateSuccess}
        />
      )}
    </div>
  );
}

type Unit = { id: number; name: string };

function ActivateUserModal({
  user,
  onCancel,
  onSuccess,
}: {
  user: PendingUser;
  onCancel: () => void;
  onSuccess: (userId: string) => void;
}) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ units: Unit[] }>('/api/admin/units')
      .then((res) => setUnits(res.units))
      .catch((e) => setErr(e instanceof Error ? e.message : 'Не удалось загрузить юниты'))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allToggle = () => {
    if (selected.size === units.length) setSelected(new Set());
    else setSelected(new Set(units.map((u) => u.id)));
  };

  const submit = async () => {
    setErr(null);
    if (selected.size === 0) {
      const ok = confirm(
        'Ни один юнит не выбран. Пользователь будет активирован, но не сможет подавать платежи. Продолжить?'
      );
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/api/admin/users/${user.id}/activate`, {
        method: 'POST',
        body: JSON.stringify({ unitIds: Array.from(selected) }),
      });
      onSuccess(user.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setSubmitting(false);
    }
  };

  const tag = user.telegramUsername ? `@${user.telegramUsername}` : '';
  const fullName = `${user.firstName} ${user.lastName ?? ''}`.trim();

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md sm:rounded-lg rounded-t-lg max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <div>
            <div className="text-base font-semibold">Активировать {fullName}</div>
            {tag && <div className="text-xs text-gray-500">{tag}</div>}
          </div>
          <button onClick={onCancel} className="text-gray-400 text-xl leading-none px-2">✕</button>
        </div>
        <div className="px-4 py-3 overflow-y-auto flex-1">
          {loading && <div className="text-sm text-gray-500 text-center py-4">Загрузка юнитов…</div>}
          {!loading && units.length === 0 && (
            <div className="text-sm text-gray-500 text-center py-4">Юнитов нет в системе.</div>
          )}
          {!loading && units.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-medium text-gray-600">
                  Доступ к юнитам ({selected.size}/{units.length})
                </div>
                <button
                  type="button"
                  onClick={allToggle}
                  className="text-xs text-blue-600 hover:underline"
                >
                  {selected.size === units.length ? 'Снять все' : 'Выбрать все'}
                </button>
              </div>
              <div className="space-y-1">
                {units.map((u) => (
                  <label
                    key={u.id}
                    className="flex items-center gap-2 px-2 py-1.5 border rounded-lg cursor-pointer hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={() => toggle(u.id)}
                    />
                    <span className="text-sm">{u.name}</span>
                  </label>
                ))}
              </div>
              {selected.size === 0 && (
                <div className="mt-3 p-2 text-xs bg-amber-50 border border-amber-200 rounded text-amber-800">
                  ⚠ Без юнитов пользователь не сможет подавать платежи.
                </div>
              )}
            </>
          )}
          {err && <div className="text-xs text-red-500 mt-2">{err}</div>}
        </div>
        <div className="px-4 py-3 border-t flex gap-2 shrink-0 bg-white">
          <button onClick={onCancel} className="px-4 py-2 bg-gray-100 rounded-lg text-sm">
            Отмена
          </button>
          <button
            onClick={submit}
            disabled={submitting || loading}
            className="flex-1 bg-amber-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-amber-700"
          >
            {submitting ? 'Активируем…' : 'Активировать'}
          </button>
        </div>
      </div>
    </div>
  );
}
