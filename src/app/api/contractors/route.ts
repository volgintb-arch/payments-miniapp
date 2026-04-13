// GET /api/contractors?q=текст — поиск контрагентов через Adesk API

import { NextRequest } from 'next/server';
import { adesk } from '@/lib/adesk/client';
import { requireAuth, badRequest } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  const q = request.nextUrl.searchParams.get('q');
  if (!q || q.length < 2) return badRequest('q must be at least 2 characters');

  const res = await adesk.searchContractors(q);
  const contractors = res.contractors ?? [];

  return Response.json({
    contractors: contractors.map((c) => ({ id: c.id, name: c.name })),
  });
}
