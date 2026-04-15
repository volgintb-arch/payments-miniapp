// GET /api/safes — список сейфов (наличка)

import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/api-helpers';

// Хардкод сейфов — меняются крайне редко
const SAFES = [
  { id: 194856, name: 'Урбан наличка' },
  { id: 206948, name: 'Наличка Детская' },
];

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  return Response.json({ safes: SAFES });
}
