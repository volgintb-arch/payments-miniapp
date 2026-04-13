// Типы ответов Adesk API

export type AdeskResponse<T> = {
  success?: boolean;
  message?: string;
  errorCode?: string;
  errors?: Record<string, string[]>;
} & T;

export type AdeskCategory = {
  id: number;
  name: string;
  type: number; // 1 = доход, 2 = расход
  isArchived?: boolean;
  group?: {
    id: number;
    name: string;
  } | null;
};

export type AdeskCategoryGroup = {
  id: number;
  name: string;
  categories: AdeskCategory[];
};

export type AdeskContractor = {
  id: number;
  name: string;
};

export type AdeskTransaction = {
  id: number;
  amount: string;
  date: string; // "DD.MM.YYYY"
  type: number; // 1 = доход, 2 = расход
  isPlanned: boolean;
  description?: string | null;
  bankAccount?: { id: number; name?: string };
  category?: { id: number; name?: string } | null;
  contractor?: { id: number; name?: string } | null;
  importedId?: string | null;
};

export type AdeskBankAccount = {
  id: number;
  name: string;
  bankName?: string;
  number?: string;
  legalEntity?: { id: number; name: string };
};

export type AdeskWebhook = {
  id: number;
  url: string;
  events: string[];
  description?: string;
};
