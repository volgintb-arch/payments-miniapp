// prisma/seed.ts
// Начальные данные: юниты, группы статей, банковские счета.
// Все id взяты из реального аккаунта Adesk через API.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ========================================
// КОНСТАНТЫ ИЗ ADESK API
// ========================================

const ADESK_LEGAL_ENTITIES = {
  LOKTIONOV: 66817, // ИП Локтионов Д.С.
  VOLGIN: 77493,    // ИП Волгин Т.Б.
} as const;

const ADESK_BANK_ACCOUNTS = {
  LOKTIONOV_TOCHKA: 171127,
  LOKTIONOV_SBER: 218650,
  VOLGIN_VTB_1: 204021,
  VOLGIN_VTB_2: 211455,
  VOLGIN_TOCHKA: 247172,
} as const;

const ADESK_CATEGORY_GROUPS = {
  OMG: 141119,
  ORGASTRO_MAIN: 173282,
  ORGASTRO_PROJECTS: 173290,
  LEGENDA: 141124,
  FRANCHISE: 221440,
  BESEDKA: 141134,
  MAIS: 155802,
  SIA: 153696,
  BADABOOM: 141136,
} as const;

// ========================================
// ОПРЕДЕЛЕНИЕ ЮНИТОВ
// ========================================

type UnitSeed = {
  name: string;
  adeskLegalEntityId: number;
  groups: Array<{ adeskGroupId: number; adeskGroupName: string; sortOrder: number }>;
  bankAccountIds: number[];
};

const UNITS: UnitSeed[] = [
  {
    name: 'BADABOOM',
    adeskLegalEntityId: ADESK_LEGAL_ENTITIES.LOKTIONOV,
    groups: [
      { adeskGroupId: ADESK_CATEGORY_GROUPS.BADABOOM, adeskGroupName: 'BADABOOM', sortOrder: 0 },
    ],
    bankAccountIds: [ADESK_BANK_ACCOUNTS.LOKTIONOV_SBER, ADESK_BANK_ACCOUNTS.LOKTIONOV_TOCHKA],
  },
  {
    name: 'OMG',
    adeskLegalEntityId: ADESK_LEGAL_ENTITIES.LOKTIONOV,
    groups: [
      { adeskGroupId: ADESK_CATEGORY_GROUPS.OMG, adeskGroupName: 'OMG', sortOrder: 0 },
    ],
    bankAccountIds: [ADESK_BANK_ACCOUNTS.LOKTIONOV_SBER, ADESK_BANK_ACCOUNTS.LOKTIONOV_TOCHKA],
  },
  {
    name: 'БЕСЕДКА',
    adeskLegalEntityId: ADESK_LEGAL_ENTITIES.LOKTIONOV,
    groups: [
      { adeskGroupId: ADESK_CATEGORY_GROUPS.BESEDKA, adeskGroupName: 'БЕСЕДКА', sortOrder: 0 },
    ],
    bankAccountIds: [ADESK_BANK_ACCOUNTS.LOKTIONOV_SBER, ADESK_BANK_ACCOUNTS.LOKTIONOV_TOCHKA],
  },
  {
    name: 'Майс',
    adeskLegalEntityId: ADESK_LEGAL_ENTITIES.LOKTIONOV,
    groups: [
      { adeskGroupId: ADESK_CATEGORY_GROUPS.MAIS, adeskGroupName: 'Майс', sortOrder: 0 },
    ],
    bankAccountIds: [ADESK_BANK_ACCOUNTS.LOKTIONOV_SBER, ADESK_BANK_ACCOUNTS.LOKTIONOV_TOCHKA],
  },
  {
    name: 'СИА',
    adeskLegalEntityId: ADESK_LEGAL_ENTITIES.LOKTIONOV,
    groups: [
      { adeskGroupId: ADESK_CATEGORY_GROUPS.SIA, adeskGroupName: 'СИА', sortOrder: 0 },
    ],
    bankAccountIds: [ADESK_BANK_ACCOUNTS.LOKTIONOV_SBER, ADESK_BANK_ACCOUNTS.LOKTIONOV_TOCHKA],
  },
  {
    name: 'ORGASTRO/URBAN/BAR',
    adeskLegalEntityId: ADESK_LEGAL_ENTITIES.VOLGIN,
    groups: [
      { adeskGroupId: ADESK_CATEGORY_GROUPS.ORGASTRO_MAIN, adeskGroupName: '#со #сс #сбар', sortOrder: 0 },
      { adeskGroupId: ADESK_CATEGORY_GROUPS.ORGASTRO_PROJECTS, adeskGroupName: 'Расходы по проектам 🔥', sortOrder: 1 },
    ],
    bankAccountIds: [ADESK_BANK_ACCOUNTS.VOLGIN_TOCHKA, ADESK_BANK_ACCOUNTS.VOLGIN_VTB_1, ADESK_BANK_ACCOUNTS.VOLGIN_VTB_2],
  },
  {
    name: 'Легенда об искателях',
    adeskLegalEntityId: ADESK_LEGAL_ENTITIES.VOLGIN,
    groups: [
      { adeskGroupId: ADESK_CATEGORY_GROUPS.LEGENDA, adeskGroupName: 'Легенда об искателях', sortOrder: 0 },
    ],
    bankAccountIds: [ADESK_BANK_ACCOUNTS.VOLGIN_TOCHKA, ADESK_BANK_ACCOUNTS.VOLGIN_VTB_1, ADESK_BANK_ACCOUNTS.VOLGIN_VTB_2],
  },
  {
    name: 'Расходы по франшизе',
    adeskLegalEntityId: ADESK_LEGAL_ENTITIES.VOLGIN,
    groups: [
      { adeskGroupId: ADESK_CATEGORY_GROUPS.FRANCHISE, adeskGroupName: 'Расходы по франшизе', sortOrder: 0 },
    ],
    bankAccountIds: [ADESK_BANK_ACCOUNTS.VOLGIN_TOCHKA, ADESK_BANK_ACCOUNTS.VOLGIN_VTB_1, ADESK_BANK_ACCOUNTS.VOLGIN_VTB_2],
  },
];

// ========================================
// SEED
// ========================================

async function main() {
  console.log('Seeding database...\n');

  for (const unitSeed of UNITS) {
    const unit = await prisma.unit.upsert({
      where: { name: unitSeed.name },
      update: {
        adeskLegalEntityId: unitSeed.adeskLegalEntityId,
      },
      create: {
        name: unitSeed.name,
        adeskLegalEntityId: unitSeed.adeskLegalEntityId,
      },
    });
    console.log(`Unit: ${unit.name} (id=${unit.id})`);

    await prisma.unitGroup.deleteMany({ where: { unitId: unit.id } });
    for (const g of unitSeed.groups) {
      await prisma.unitGroup.create({
        data: {
          unitId: unit.id,
          adeskGroupId: g.adeskGroupId,
          adeskGroupName: g.adeskGroupName,
          sortOrder: g.sortOrder,
        },
      });
    }
    console.log(`  groups: ${unitSeed.groups.map(g => g.adeskGroupName).join(', ')}`);

    await prisma.unitBankAccount.deleteMany({ where: { unitId: unit.id } });
    for (const bankAccountId of unitSeed.bankAccountIds) {
      await prisma.unitBankAccount.create({
        data: {
          unitId: unit.id,
          adeskBankAccountId: bankAccountId,
        },
      });
    }
    console.log(`  bank accounts: ${unitSeed.bankAccountIds.length}\n`);
  }

  console.log('Seed completed.\n');
  console.log('Next steps:');
  console.log('  1. Login to mini-app via Telegram -> User will be created with isActive=false');
  console.log('  2. Use Prisma Studio or SQL to set role=ADMIN and isActive=true for yourself');
  console.log('  3. Add other users via /admin/users');
  console.log('  4. Run category sync: POST /api/admin/sync');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
