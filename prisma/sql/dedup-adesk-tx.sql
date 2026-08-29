-- prisma/sql/dedup-adesk-tx.sql
--
-- Разовый скрипт, который нужно выполнить на проде ОДИН РАЗ ПЕРЕД тем, как
-- применять @unique на Payment.adeskConfirmedTransactionId (db push / migrate).
--
-- Что делает: находит транзакции Adesk, привязанные больше чем к одному
-- платежу (следствие гонок до появления констрейнта), оставляет самую раннюю
-- привязку, а с остальных платежей снимает привязку и переводит их в
-- NEEDS_REVIEW для ручного разбора. Ни один платёж не удаляется.
--
-- Запуск:  psql "$DATABASE_URL" -f prisma/sql/dedup-adesk-tx.sql
-- Проверка «сколько дублей» до запуска:
--   SELECT "adeskConfirmedTransactionId", count(*)
--   FROM "Payment"
--   WHERE "adeskConfirmedTransactionId" IS NOT NULL
--   GROUP BY 1 HAVING count(*) > 1;

BEGIN;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "adeskConfirmedTransactionId"
      ORDER BY "matchedAt" NULLS LAST, "createdAt"
    ) AS rn
  FROM "Payment"
  WHERE "adeskConfirmedTransactionId" IS NOT NULL
)
UPDATE "Payment" p
SET
  "adeskConfirmedTransactionId" = NULL,
  "status" = 'NEEDS_REVIEW'
FROM ranked r
WHERE p.id = r.id
  AND r.rn > 1;

COMMIT;

-- После успешного выполнения применить схему:
--   pnpm exec prisma db push          (или сгенерированную migrate-миграцию)
-- db push создаст сам уникальный индекс Payment_adeskConfirmedTransactionId_key.
