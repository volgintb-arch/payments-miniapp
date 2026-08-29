// GET /api/safes — список сейфов (наличка)

import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/api-helpers';
import { SAFES } from '@/lib/safes';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  return Response.json({ safes: SAFES });
}
