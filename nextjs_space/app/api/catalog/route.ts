import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { coneSearch, type RawStar } from '@/lib/spherex/irsa';
import type { CatStar } from '@/lib/spherex/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROOT = path.join(process.env.SPHEREX_CACHE_DIR ?? '/tmp/spherex_cache', 'catalogs');

export async function GET(req: Request) {
  const u = new URL(req.url);
  const ra = parseFloat(u.searchParams.get('ra') ?? '');
  const dec = parseFloat(u.searchParams.get('dec') ?? '');
  const fov = Math.min(10, Math.max(1, parseFloat(u.searchParams.get('fov') ?? '5') || 5));
  const src = u.searchParams.get('src') === 'allwise' ? 'allwise' : 'gaia';
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return NextResponse.json({ error: 'Invalid coordinates' }, { status: 400 });
  const file = path.join(/*turbopackIgnore: true*/ ROOT, `${src}_${ra.toFixed(4)}_${dec.toFixed(4)}_${fov}.json`);
  try {
    if (fs.existsSync(file)) return NextResponse.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { /* re-query */ }
  try {
    const radius = ((fov / 60) / 2) * Math.SQRT2 + 0.005;
    const raw = await coneSearch(src, ra, dec, radius);
    const stars: CatStar[] = raw
      .sort((a: RawStar, b: RawStar) => (a.mag ?? 99) - (b.mag ?? 99))
      .slice(0, 400)
      .map((s: RawStar) => ({ id: s.id, ra: s.ra, dec: s.dec, mag: s.mag, pmra: s.pmra, pmdec: s.pmdec }));
    const body = { src, epoch: src === 'gaia' ? 2016.0 : 2010.5, count: raw.length, stars };
    try { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(file, JSON.stringify(body)); } catch { /* cache optional */ }
    return NextResponse.json(body);
  } catch (e) {
    console.warn('catalog failed', (e as Error)?.message);
    return NextResponse.json({ error: `${src === 'gaia' ? 'Gaia DR3' : 'AllWISE'} catalog unavailable right now`, stars: [] }, { status: 502 });
  }
}
