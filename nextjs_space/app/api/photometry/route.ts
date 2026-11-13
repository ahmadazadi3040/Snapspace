import { NextResponse } from 'next/server';
import { getDataset, photometry } from '@/lib/spherex/pipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const L = getDataset(u.searchParams.get('key') ?? '');
    if (!L) return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    const n = L.summary.grid.n;
    const x = parseFloat(u.searchParams.get('x') ?? '');
    const y = parseFloat(u.searchParams.get('y') ?? '');
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.5 || y < -0.5 || x > n - 0.5 || y > n - 0.5) {
      return NextResponse.json({ error: 'Pixel outside the field' }, { status: 400 });
    }
    return NextResponse.json(photometry(L, x, y));
  } catch (e) {
    console.error('photometry failed', e);
    return NextResponse.json({ error: 'Photometry failed' }, { status: 500 });
  }
}
