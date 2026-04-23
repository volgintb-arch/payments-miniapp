'use client';

import { useEffect, useState } from 'react';
import { apiFetch, setToken } from '@/lib/hooks/use-api';
import { PaymentForm } from './components/payment-form';
import { PaymentList } from './components/payment-list';
import { AdminPending } from './components/admin-pending';

type UserInfo = {
  id: string;
  firstName: string;
  lastName: string | null;
  role: string;
};

export default function Home() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'create' | 'list' | 'admin'>('create');
  const [chatId, setChatId] = useState<string | null>(null);

  useEffect(() => {
    // Даём время Telegram SDK загрузиться
    const timer = setTimeout(() => {
      init();
    }, 500);
    return () => clearTimeout(timer);

    async function init() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tg = (window as any).Telegram?.WebApp;

      // Читаем chat_id СРАЗУ, до проверки токена
      // start_param формат: c<chatId>t<threadId> или c<chatId>
      if (tg?.initDataUnsafe) {
        const sp = tg.initDataUnsafe.start_param;
        if (sp && sp.startsWith('c')) {
          const match = sp.match(/^c(\d+)(?:t(\d+))?$/);
          if (match) {
            const cid = `-${match[1]}`;
            const tid = match[2];
            setChatId(tid ? `${cid}_${tid}` : cid);
          }
        } else if (tg.initDataUnsafe.chat?.id) {
          setChatId(String(tg.initDataUnsafe.chat.id));
        }
      }

      try {
        const token = localStorage.getItem('token');
        if (token) {
          try {
            await apiFetch('/api/units');
            const payload = JSON.parse(atob(token.split('.')[1]));
            setUser({
              id: payload.sub,
              firstName: '',
              lastName: null,
              role: payload.role,
            });
            setLoading(false);
            return;
          } catch {
            localStorage.removeItem('token');
          }
        }

        if (!tg?.initData) {
          setError('Откройте приложение через Telegram');
          setLoading(false);
          return;
        }

        tg.ready();
        tg.expand();

        const res = await apiFetch<{ token: string; user: UserInfo }>(
          '/api/auth/login',
          {
            method: 'POST',
            body: JSON.stringify({ initData: tg.initData }),
          },
        );

        setToken(res.token);
        setUser(res.user);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка авторизации');
      } finally {
        setLoading(false);
      }
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg text-gray-500">Загрузка...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="text-lg text-red-500 mb-2">Ошибка</div>
          <div className="text-gray-600">{error}</div>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <main className="max-w-lg mx-auto px-4 py-6">
      <header className="mb-6">
        <h1 className="text-xl font-bold">Платежи</h1>
        <p className="text-sm text-gray-500">
          {user.firstName} {user.lastName} · {user.role}
        </p>
      </header>

      <nav className="flex gap-2 mb-6">
        <button
          onClick={() => setTab('create')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === 'create'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Новый платёж
        </button>
        <button
          onClick={() => setTab('list')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === 'list'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Мои платежи
        </button>
        {user.role === 'ADMIN' && (
          <button
            onClick={() => setTab('admin')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'admin'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Проблемы
          </button>
        )}
      </nav>

      {tab === 'create' && (
        <PaymentForm onSuccess={() => setTab('list')} chatId={chatId} />
      )}
      {tab === 'list' && <PaymentList />}
      {tab === 'admin' && user.role === 'ADMIN' && <AdminPending />}
    </main>
  );
}
