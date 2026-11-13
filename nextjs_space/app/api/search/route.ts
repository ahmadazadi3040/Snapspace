import { NextResponse } from 'next/server';
import { startJob } from '@/lib/spherex/pipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FOV_MIN = 1;
const FOV_MAX = 20;

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const ra = parseFloat(u.searchParams.get('ra') ?? '');
    const dec = parseFloat(u.searchParams.get('dec') ?? '');
    const fovRaw = parseFloat(u.searchParams.get('fov') ?? '5');
    const fov = Number.isFinite(fovRaw) ? Math.min(FOV_MAX, Math.max(FOV_MIN, Math.round(fovRaw))) : 5;
    const demo = u.searchParams.get('demo') === '1';
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || Math.abs(dec) > 90) {
      return NextResponse.json({ error: 'Invalid coordinates: RA must be 0–360°, Dec −90–+90°' }, { status: 400 });
    }
    const job = startJob(ra, dec, fov, demo);
    const { key, status, progress, message, summary, error } = job;
    return NextResponse.json({ key, status, progress, message, summary, error });
  } catch (e) {
    console.error('search failed', e);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
