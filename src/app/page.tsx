'use client';

import { useEffect, useState } from 'react';
import { apiFetch, setToken } from '@/lib/hooks/use-api';
import { PaymentForm } from './components/payment-form';
import { PaymentList } from './components/payment-list';
import { AdminPending } from './components/admin-pending';
import { AdminUncategorized } from './components/admin-uncategorized';
import { IncomeForm } from './components/income-form';

type UserInfo = {
  id: string;
  firstName: string;
  lastName: string | null;
  role: string;
};

// SDK приезжает отдельным <script async> с telegram.org, то есть уже после
// гидрации, а на медленной сети — сильно после. Поэтому window опрашиваем до
// дедлайна, а не читаем один раз и надеемся.
const TG_SDK_TIMEOUT_MS = 15_000;

// telegram.org у части операторов недоступен: на этом же сервере наглухо не
// открывается api.telegram.org (UND_ERR_CONNECT_TIMEOUT в логах), и та же
// участь у клиентов — приложение просто не грузилось. Поэтому держим копию
// SDK в public/ и подставляем её со своего домена, если с telegram.org за
// FALLBACK_AFTER_MS ничего не приехало. Свой домен заведомо доступен: с него
// только что загрузилась сама страница.
const TG_SDK_FALLBACK_SRC = '/telegram-web-app.js';
const TG_SDK_FALLBACK_AFTER_MS = 4_000;

function injectLocalSdk(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`script[src="${TG_SDK_FALLBACK_SRC}"]`)) return;
  const el = document.createElement('script');
  el.src = TG_SDK_FALLBACK_SRC;
  el.async = true;
  el.onerror = () => console.error('[init] local Telegram SDK failed to load');
  document.head.appendChild(el);
}

type TgWebApp = {
  initData?: string;
  initDataUnsafe?: {
    start_param?: string;
    chat?: { id: number };
  };
  colorScheme?: 'light' | 'dark';
  ready?: () => void;
  expand?: () => void;
  onEvent?: (event: string, cb: () => void) => void;
  offEvent?: (event: string, cb: () => void) => void;
};

function getTg(): TgWebApp | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp;
}

async function waitForTg(timeoutMs: number): Promise<TgWebApp | undefined> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let fellBack = false;
  for (;;) {
    const tg = getTg();
    if (tg) return tg;
    if (!fellBack && Date.now() - started >= TG_SDK_FALLBACK_AFTER_MS) {
      fellBack = true;
      injectLocalSdk();
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export default function Home() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [pending, setPending] = useState<{ firstName: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingStep, setLoadingStep] = useState('Инициализация…');
  const [showRetry, setShowRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'create' | 'income' | 'list' | 'admin' | 'uncategorized'>('create');
  const [chatId, setChatId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let themeSource: TgWebApp | undefined;

    // Синхронизация темы Telegram → класс .dark на <html>. SDK перечитываем
    // на каждом вызове: на первом рендере его ещё может не быть в window.
    function applyTheme() {
      const scheme = getTg()?.colorScheme;
      const isDark =
        scheme === 'dark' ||
        (!scheme && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', isDark);
    }
    applyTheme();

    // Ждём SDK в фоне и не блокируем им старт: сохранённая сессия из
    // localStorage Telegram не требует. Тема и chatId подтянутся, когда (и
    // если) SDK приедет.
    const tgReady = waitForTg(TG_SDK_TIMEOUT_MS);
    tgReady.then((tg) => {
      if (cancelled || !tg) return;
      themeSource = tg;
      tg.onEvent?.('themeChanged', applyTheme);
      applyTheme();
      // Оборачиваем — на iOS SDK может кинуть при чтении initDataUnsafe
      // в неудачный момент.
      try {
        const sp = tg.initDataUnsafe?.start_param;
        if (sp && sp.startsWith('c')) {
          const match = sp.match(/^c(\d+)(?:t(\d+))?$/);
          if (match) {
            const cid = `-${match[1]}`;
            const tid = match[2];
            setChatId(tid ? `${cid}_${tid}` : cid);
          }
        } else if (tg.initDataUnsafe?.chat?.id) {
          setChatId(String(tg.initDataUnsafe.chat.id));
        }
      } catch (err) {
        console.warn('[init] failed to read tg.initDataUnsafe:', err);
      }
    });

    // Кнопка «Обновить» появится через 10 секунд, если авторизация ещё висит.
    const retryTimer = setTimeout(() => setShowRetry(true), 10_000);

    // Аварийный таймер: если init() тихо не доехал (JS-ошибка в SDK,
    // недоступный localStorage, зависший fetch) — показываем ошибку. Лестница
    // порогов: подсказка «что-то долго» + кнопка на 10 с, дедлайн SDK 15 с,
    // таймаут apiFetch 30 с, и только потом этот. Раньше он стоял на 20 с и
    // гасил живой запрос, который вот-вот вернулся бы.
    const bailTimer = setTimeout(() => {
      if (cancelled) return;
      setError('Приложение не смогло инициализироваться. Попробуйте обновить страницу.');
      setLoading(false);
    }, 60_000);

    init();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      clearTimeout(bailTimer);
      themeSource?.offEvent?.('themeChanged', applyTheme);
    };

    async function init() {
      try {
        // 1. Сохранённая сессия. Проверяем ДО Telegram: она работает без SDK,
        //    и когда telegram.org недоступен, постоянный пользователь всё
        //    равно попадёт в приложение.
        let token: string | null = null;
        try {
          token = localStorage.getItem('token');
        } catch (err) {
          // В приватном режиме Safari или при заблокированных cookies
          // localStorage бросает SecurityError.
          console.warn('[init] localStorage unavailable:', err);
        }

        if (token) {
          try {
            setLoadingStep('Проверяем сессию…');
            await apiFetch('/api/units');
            if (cancelled) return;
            const payload = JSON.parse(atob(token.split('.')[1]));
            setUser({
              id: payload.sub,
              firstName: '',
              lastName: null,
              role: payload.role,
            });
            return;
          } catch {
            try { localStorage.removeItem('token'); } catch {}
          }
        }

        // 2. Сессии нет — без Telegram дальше никак.
        setLoadingStep('Ждём Telegram…');
        const tg = await tgReady;
        if (cancelled) return;

        if (!tg) {
          setError(
            'Не удалось загрузить Telegram — ни с telegram.org, ни с нашего ' +
            'сервера. Проверьте соединение и откройте приложение заново.',
          );
          return;
        }
        if (!tg.initData) {
          setError('Откройте приложение через Telegram');
          return;
        }

        setLoadingStep('Авторизация через Telegram…');
        try { tg.ready?.(); } catch {}
        try { tg.expand?.(); } catch {}

        const res = await apiFetch<
          | { token: string; user: UserInfo }
          | { pending: true; firstName: string; lastName: string | null }
        >('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ initData: tg.initData }),
        });
        if (cancelled) return;

        if ('pending' in res) {
          // Логин прошёл (initData валиден), но isActive=false — ждём
          // активации админом. Никакого токена не пишем в localStorage.
          setPending({ firstName: res.firstName });
        } else {
          setToken(res.token);
          setUser(res.user);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Ошибка авторизации');
      } finally {
        if (!cancelled) {
          setLoading(false);
          clearTimeout(bailTimer);
        }
      }
    }
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 px-4">
        <div className="text-lg text-gray-500">{loadingStep}</div>
        {showRetry && (
          <>
            <div className="text-xs text-gray-400 text-center max-w-xs">
              Что-то долго. Проверьте интернет и обновите страницу.
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm"
            >
              Обновить
            </button>
          </>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="text-center max-w-sm">
          <div className="text-lg text-red-500 mb-2">Ошибка</div>
          <div className="text-gray-600 mb-4">{error}</div>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm"
          >
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  if (pending) {
    return (
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="text-center max-w-sm">
          <div className="text-lg font-semibold mb-2">Доступ ещё не выдан</div>
          <div className="text-gray-600">
            Здравствуйте, {pending.firstName}! Ваш аккаунт зарегистрирован,
            администратор получил уведомление. Как только доступ откроют,
            приложение заработает.
          </div>
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

      <nav className={`grid gap-1.5 mb-6 ${user.role === 'ADMIN' ? 'grid-cols-5' : 'grid-cols-4'}`}>
        <button
          onClick={() => setTab('create')}
          className={`py-2 rounded-lg text-xs font-medium transition-colors ${
            tab === 'create'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Расход
        </button>
        <button
          onClick={() => setTab('income')}
          className={`py-2 rounded-lg text-xs font-medium transition-colors ${
            tab === 'income'
              ? 'bg-green-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Приход
        </button>
        <button
          onClick={() => setTab('list')}
          className={`py-2 rounded-lg text-xs font-medium transition-colors ${
            tab === 'list'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          История
        </button>
        {user.role === 'ADMIN' && (
          <button
            onClick={() => setTab('admin')}
            className={`py-2 rounded-lg text-xs font-medium transition-colors ${
              tab === 'admin'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Проблемы
          </button>
        )}
        <button
          onClick={() => setTab('uncategorized')}
          className={`py-2 rounded-lg text-xs font-medium transition-colors ${
            tab === 'uncategorized'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Неопознанные
        </button>
      </nav>

      {tab === 'create' && (
        <PaymentForm onSuccess={() => setTab('list')} chatId={chatId} />
      )}
      {tab === 'income' && (
        <IncomeForm onSuccess={() => setTab('list')} chatId={chatId} />
      )}
      {tab === 'list' && <PaymentList />}
      {tab === 'admin' && user.role === 'ADMIN' && <AdminPending />}
      {tab === 'uncategorized' && <AdminUncategorized chatId={chatId} />}
    </main>
  );
}
