import { BlinkApp } from './_components/blink-app';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = (await searchParams) ?? {};
  const one = (k: string) => { const v = sp?.[k]; return Array.isArray(v) ? v?.[0] : v; };
  const ra = parseFloat(one('ra') ?? '');
  const dec = parseFloat(one('dec') ?? '');
  const fovRaw = parseFloat(one('fov') ?? '5');
  const fov = [2, 5, 10].includes(fovRaw) ? fovRaw : 5;
  const valid = Number.isFinite(ra) && Number.isFinite(dec) && ra >= 0 && ra < 360 && Math.abs(dec) <= 90;
  const initial = valid ? { ra, dec, fov, demo: false } : null;
  return <BlinkApp initial={initial} />;
}
