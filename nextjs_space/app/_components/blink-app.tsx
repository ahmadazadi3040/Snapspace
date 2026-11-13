'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import {
  Search, Orbit, Satellite, FlaskConical, Star, History, Share2, AlertTriangle,
  Loader2, Activity, LineChart as LineIcon, Radio, MousePointerClick,
} from 'lucide-react';
import { BlinkViewer } from './blink-viewer';
import {
  PRESETS, parseCoords, fmtSexa, type Preset, type JobStatus, type PhotResult,
} from '@/lib/spherex/shared';

const SpectrumChart = dynamic(() => import('./charts').then((m: typeof import('./charts')) => m.SpectrumChart), { ssr: false, loading: () => <ChartLoading /> });
const LightCurveChart = dynamic(() => import('./charts').then((m: typeof import('./charts')) => m.LightCurveChart), { ssr: false, loading: () => <ChartLoading /> });

function ChartLoading() {
  return <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading chart…</div>;
}

interface Target { ra: number; dec: number; fov: number; demo: boolean }
interface Recent { id: string; ra: number; dec: number; fov: number; dataMode: string; epochCount: number; exposureCount: number; hits: number }
export interface AppUser { name: string | null; email: string | null }

const FOVS = [1, 5, 10];
const near = (a: number, b: number) => Math.abs(a - b) < 2e-4;
const findPreset = (t: Target | null) => (t ? PRESETS.find((p: Preset) => near(p.ra, t.ra) && near(p.dec, t.dec)) ?? null : null);

export function BlinkApp({ initial }: { initial: Target | null }) {
  const router = useRouter();
  const def = PRESETS.find((p: Preset) => p.name === 'WISE 0855') ?? PRESETS[0];
  const start: Target = initial ?? { ra: def?.ra ?? 133.76001, dec: def?.dec ?? -7.2421, fov: 5, demo: false };
  const [query, setQuery] = useState(`${start.ra.toFixed(5)}, ${start.dec.toFixed(5)}`);
  const [fov, setFov] = useState(start.fov);
  const [target, setTarget] = useState<Target | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  const [phot, setPhot] = useState<PhotResult | null>(null);
  const [photBusy, setPhotBusy] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const token = useRef(0);

  const summary = job?.status === 'ready' ? job?.summary ?? null : null;
  const preset = findPreset(target);

  const loadRecent = useCallback(async () => {
    try { const r = await fetch('/api/recent'); const j = await r.json(); setRecent((j?.recent ?? []) as Recent[]); } catch (e) { console.error(e); }
  }, []);

  const measure = useCallback(async (key: string, x: number, y: number) => {
    setPick({ x, y });
    setPhotBusy(true);
    try {
      const r = await fetch(`/api/photometry?key=${encodeURIComponent(key)}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? 'Photometry failed');
      setPhot(j as PhotResult);
    } catch (e) {
      console.error(e);
      toast.error((e as Error)?.message ?? 'Photometry failed');
    } finally { setPhotBusy(false); }
  }, []);

  const run = useCallback(async (t: Target) => {
    const my = ++token.current;
    setTarget(t); setErr(null); setPhot(null); setPick(null);
    setQuery(`${t.ra.toFixed(5)}, ${t.dec.toFixed(5)}`); setFov(t.fov);
    setJob({ key: '', status: 'running', progress: 0, message: 'Querying IRSA SIA2 for SPHEREx DR1 images…' });
    router.replace(`/?ra=${t.ra.toFixed(5)}&dec=${t.dec.toFixed(5)}&fov=${t.fov}${t.demo ? '&demo=1' : ''}`, { scroll: false });
    const url = `/api/search?ra=${t.ra}&dec=${t.dec}&fov=${t.fov}${t.demo ? '&demo=1' : ''}`;
    for (let i = 0; i < 240 && my === token.current; i++) {
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (my !== token.current) return;
        if (!r.ok) { setErr(j?.error ?? 'Search failed'); setJob(null); return; }
        setJob(j as JobStatus);
        if (j?.status === 'ready') {
          const s = (j as JobStatus)?.summary;
          if (s) { const c = (s.grid.n - 1) / 2; measure(s.key, c, c); }
          loadRecent();
          return;
        }
        if (j?.status === 'error') { setErr(j?.error ?? 'Pipeline failed'); return; }
      } catch (e) { console.error('poll failed', e); }
      await new Promise((res: (v: unknown) => void) => setTimeout(res, 1000));
    }
    if (my === token.current) setErr('The archive is taking unusually long – please try again.');
  }, [router, measure, loadRecent]);

  useEffect(() => { run(start); loadRecent(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseCoords(query);
    if (!p) { toast.error('Enter coordinates like “133.76, -7.24” or “08h55m10.8s -07d14m42s”'); return; }
    run({ ra: p.ra, dec: p.dec, fov, demo: false });
  };

  const share = async () => {
    const href = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: 'Snapspace', text: preset?.name ?? 'SPHEREx field', url: href });
      else { await navigator.clipboard.writeText(href); toast.success('Link copied'); }
    } catch (e) { console.warn(e); }
  };

  const running = job?.status === 'running';
  const epochLabels = (summary?.epochs ?? []).map((e: { utc: string }, i: number) => `E${i + 1} · ${e?.utc?.slice(0, 10) ?? ''}`);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 bg-background/70 backdrop-blur-md shadow-[0_1px_0_rgba(255,255,255,0.04)]">
        <div className="mx-auto flex max-w-[1200px] items-center gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.jpg" alt="Snapspace logo" className="h-14 w-14 rounded-xl bg-white object-cover shadow-md ring-1 ring-white/15" />
            <span className="font-display text-lg font-bold tracking-tight">Snap<span className="text-primary">space</span></span>
          </Link>
          <div className="ml-2 hidden sm:block">
            {summary?.mode === 'live' && <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-400/30"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />Live NASA/IRSA Data</span>}
            {summary?.mode === 'demo' && <span title={summary?.reason ?? 'Synthetic data'} className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-300 ring-1 ring-amber-400/30"><FlaskConical className="h-3.5 w-3.5" />Simulated Demo Mode</span>}
            {!summary && <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground"><Radio className="h-3.5 w-3.5" />{running ? 'Contacting archive…' : 'No field loaded'}</span>}
          </div>

        </div>
      </header>

      <main className="mx-auto max-w-[1200px] space-y-6 px-4 py-6">
        <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="space-y-4">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">View SPHEREx snapshots with <span className="text-primary">SnapSpace</span></h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Flip through NASA SPHEREx all-sky epochs (0.75–5 µm) to spot brown dwarfs, asteroids and variable stars – then click any source to pull its spectrum and light curve.</p>
          </div>

          <form onSubmit={submit} className="rounded-xl bg-card/80 p-4 shadow-lg backdrop-blur">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} aria-label="Sky coordinates"
                  placeholder="RA, Dec – e.g. 133.76, -7.242 or 08h55m10.83s -07d14m42.5s"
                  className="w-full rounded-lg bg-background/70 py-2.5 pl-10 pr-3 font-mono text-sm shadow-inner outline-none ring-1 ring-white/5 focus:ring-primary"
                />
              </div>
              <div className="flex items-center gap-3">
                <div className="inline-flex rounded-lg bg-secondary/60 p-1" role="radiogroup" aria-label="Field of view">
                  {FOVS.map((f: number) => (
                    <button key={f} type="button" role="radio" aria-checked={fov === f} onClick={() => setFov(f)}
                      className={`rounded-md px-3 py-1.5 font-mono text-xs font-semibold transition ${fov === f ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}>{f}′</button>
                  ))}
                </div>
                <button type="submit" disabled={running} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition hover:bg-primary/85 disabled:opacity-60">
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Satellite className="h-4 w-4" />}Blink
                </button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {PRESETS.map((p: Preset) => {
                const active = preset?.name === p.name;
                return (
                  <button key={p.name} type="button" title={`${p.note}${p.catalog ? ` · catalogue: ${p.catalog}` : ''}`} onClick={() => run({ ra: p.ra, dec: p.dec, fov, demo: false })}
                    className={`group inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-sm transition ${active ? 'bg-accent text-accent-foreground' : 'bg-secondary/70 text-secondary-foreground hover:bg-accent/20'}`}>
                    {p.pm ? <Orbit className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}{p.name}
                  </button>
                );
              })}
            </div>
          </form>
        </motion.section>

        {running && (
          <div className="rounded-xl bg-card/80 p-5 shadow-lg">
            <div className="mb-2 flex items-center justify-between text-sm"><span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin text-primary" />{job?.message ?? 'Working…'}</span><span className="font-mono text-xs text-muted-foreground">{Math.round((job?.progress ?? 0) * 100)}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary"><motion.div className="h-full bg-gradient-to-r from-primary to-accent" animate={{ width: `${Math.max(3, (job?.progress ?? 0) * 100)}%` }} transition={{ duration: 0.4 }} /></div>
            <p className="mt-2 text-xs text-muted-foreground">Live archive fields take ~20–30 s the first time (cutouts of every SPHEREx exposure are fetched, reprojected and stacked); repeat visits load from cache.</p>
          </div>
        )}

        {err && (
          <div className="flex items-start gap-3 rounded-xl bg-destructive/15 p-4 text-sm text-red-200 shadow"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="font-semibold">Sorry – that field could not be loaded.</p><p className="text-xs opacity-80">{err}</p></div></div>
        )}

        {summary?.mode === 'demo' && (
          <div className="flex items-start gap-3 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-200 shadow"><FlaskConical className="mt-0.5 h-4 w-4 shrink-0" /><p><b>Simulated Demo Mode.</b> These frames are synthetic (field stars, a cold brown dwarf, a high-proper-motion star, a Mira variable and an asteroid) {summary?.reason ? `– ${summary.reason}` : ''}. Turn Demo off and search again for live SPHEREx data.</p></div>
        )}

        {summary && (
          <motion.section key={summary.key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="rounded-xl bg-card/50 p-4 shadow-xl">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-semibold">{preset?.name ?? 'Custom field'}</h2>
              <span className="font-mono text-xs text-muted-foreground">{target ? fmtSexa(target.ra, target.dec) : ''}</span>
              {preset && <span className="text-xs text-muted-foreground">· {preset.note}</span>}
              <div className="ml-auto flex gap-2">
                <button onClick={share} className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium shadow-sm transition hover:bg-secondary/70"><Share2 className="h-3.5 w-3.5" />Share</button>
              </div>
            </div>
            <BlinkViewer summary={summary} preset={preset} pick={pick} onPick={(x: number, y: number) => measure(summary.key, x, y)} />
          </motion.section>
        )}

        {summary && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Activity className="h-5 w-5 text-accent" />Aperture photometry</h2>
              {phot && <span className="font-mono text-xs text-muted-foreground">{fmtSexa(phot.ra, phot.dec)} · pixel ({phot.x.toFixed(1)}, {phot.y.toFixed(1)}) · r = 1.6 px (9.8″)</span>}
              {photBusy && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
              <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"><MousePointerClick className="h-3.5 w-3.5" />Click the image to measure another source</span>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl bg-card/80 p-4 shadow-lg">
                <h3 className="mb-1 text-sm font-semibold">Spectrum – flux vs wavelength</h3>
                <p className="mb-2 text-[11px] text-muted-foreground">Each point is one SPHEREx exposure; the linear-variable filter gives every pixel its own wavelength. {phot ? `${phot.spectrum?.length ?? 0} samples.` : ''}</p>
                <div className="h-72">{(phot?.spectrum?.length ?? 0) > 0 ? <SpectrumChart points={phot?.spectrum ?? []} epochLabels={epochLabels} /> : <Empty busy={photBusy} />}</div>
              </div>
              <div className="rounded-xl bg-card/80 p-4 shadow-lg">
                <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><LineIcon className="h-4 w-4 text-primary" />Light curve – brightness over time</h3>
                <p className="mb-2 text-[11px] text-muted-foreground">Per-epoch stacked flux in each detector band (D1 shortest → D6 longest wavelength).</p>
                <div className="h-72">{(phot?.lightcurve ?? []).some((p: Record<string, unknown>) => Object.keys(p ?? {}).some((k: string) => k.startsWith('D'))) ? <LightCurveChart points={phot?.lightcurve ?? []} /> : <Empty busy={photBusy} />}</div>
              </div>
            </div>
          </section>
        )}

        <section className="grid gap-4">
          <div className="rounded-xl bg-card/70 p-4 shadow-lg">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-primary" />Recently blinked fields</h3>
            {recent.length === 0 && <p className="text-xs text-muted-foreground">No fields yet.</p>}
            <ul className="space-y-1.5">
              {recent.map((r: Recent) => {
                const p = findPreset({ ra: r.ra, dec: r.dec, fov: r.fov, demo: false });
                return (
                  <li key={r.id}>
                    <button onClick={() => run({ ra: r.ra, dec: r.dec, fov: r.fov, demo: false })} className="flex w-full items-center gap-2 rounded-md bg-secondary/50 px-3 py-2 text-left text-xs shadow-sm transition hover:bg-secondary">
                      <span className={`h-2 w-2 rounded-full ${r.dataMode === 'live' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                      <span className="font-medium">{p?.name ?? 'Field'}</span>
                      <span className="font-mono text-muted-foreground">{r.ra.toFixed(4)}, {r.dec.toFixed(4)} · {r.fov}′</span>
                      <span className="ml-auto font-mono text-muted-foreground">{r.epochCount} ep · {r.exposureCount} exp</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </main>

      <footer className="mx-auto max-w-[1200px] px-4 pb-8 pt-2 text-center text-[11px] text-muted-foreground">
        Data: NASA SPHEREx DR1 via NASA/IPAC Infrared Science Archive (IRSA) · Gaia DR3 (ESA) · AllWISE (NASA/JPL-Caltech) · Built for NASA Space Apps
      </footer>
    </div>
  );
}

function Empty({ busy }: { busy: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <MousePointerClick className="h-5 w-5" />}
      {busy ? 'Measuring…' : 'No unmasked flux at this position (saturated or flagged) – click a source in the image.'}
    </div>
  );
}
