import { NextResponse } from 'next/server';
import { getDataset, renderFrame, type Mode } from '@/lib/spherex/pipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const key = u.searchParams.get('key') ?? '';
    const e = parseInt(u.searchParams.get('e') ?? '0', 10);
    const m = u.searchParams.get('mode') ?? 'normal';
    const mode: Mode = m === 'diff' || m === 'rgb' ? m : 'normal';
    const b = u.searchParams.get('band') ?? 'all';
    const band = /^[1-6]$/.test(b) ? b : 'all';
    const L = getDataset(key);
    if (!L) return NextResponse.json({ error: 'Dataset not found – run a search first' }, { status: 404 });
    const png = renderFrame(L, e, mode, band);
    if (!png) return NextResponse.json({ error: 'Epoch out of range' }, { status: 404 });
    return new NextResponse(new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  } catch (err) {
    console.error('frame failed', err);
    return NextResponse.json({ error: 'Render failed' }, { status: 500 });
  }
}
