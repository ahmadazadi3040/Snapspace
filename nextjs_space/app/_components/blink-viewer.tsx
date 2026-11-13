'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Crosshair, Layers, Gauge, CalendarClock, Flag, Telescope, Sparkles, Loader2, Navigation,
} from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import {
  BANDS, PIX_ARCSEC, gridToWorld, worldToGrid, propagate, mjdToYear, fmtSexa,
  type DatasetSummary, type CatStar, type Preset, type EpochMeta,
} from '@/lib/spherex/shared';

type Mode = 'normal' | 'diff' | 'rgb';
type Src = 'gaia' | 'allwise';
interface CatState { loading: boolean; stars: CatStar[]; error?: string; count?: number }

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'normal', label: 'Normal', hint: 'Stacked surface brightness per epoch' },
  { id: 'diff', label: 'Difference', hint: 'Epoch N − Epoch 1: movers appear as black/white pairs' },
  { id: 'rgb', label: 'RGB IR', hint: 'R = D5–D6 (3.8–5.0 µm) · G = D3–D4 (1.6–3.8 µm) · B = D1–D2 (0.75–1.6 µm)' },
];

function Toggle({ on, onClick, children, color }: { on: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={on}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium shadow-sm transition ${on ? 'bg-primary/15 text-foreground ring-1 ring-primary/50' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
    >
      {color && <span className="h-2.5 w-2.5 rounded-full ring-2" style={{ borderColor: color, boxShadow: `inset 0 0 0 2px ${color}` }} />}
      {children}
    </button>
  );
}

export function BlinkViewer({
  summary, preset, pick, onPick,
}: { summary: DatasetSummary; preset: Preset | null; pick: { x: number; y: number } | null; onPick: (x: number, y: number) => void }) {
  const epochs: EpochMeta[] = summary?.epochs ?? [];
  const count = epochs?.length ?? 0;
  const g = summary?.grid;
  const n = g?.n ?? 1;
  const [epoch, setEpoch] = useState(0);
  const [mode, setMode] = useState<Mode>('normal');
  const [band, setBand] = useState<string>('all');
  const [playing, setPlaying] = useState(count > 1);
  const [fps, setFps] = useState(2);
  const [reticle, setReticle] = useState(true);
  const [track, setTrack] = useState(true);
  const [show, setShow] = useState<Record<Src, boolean>>({ gaia: false, allwise: false });
  const [cats, setCats] = useState<Record<Src, CatState | null>>({ gaia: null, allwise: null });
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<[number, number] | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setEpoch(0); setLoaded({}); setCats({ gaia: null, allwise: null }); setPlaying((summary?.epochs?.length ?? 0) > 1); }, [summary?.key, summary?.epochs?.length]);

  useEffect(() => {
    if (!playing || count < 2) return;
    const id = setInterval(() => setEpoch((e: number) => (e + 1) % count), 1000 / Math.max(1, fps));
    return () => clearInterval(id);
  }, [playing, fps, count]);

  const step = useCallback((d: number) => { setPlaying(false); setEpoch((e: number) => (count ? (e + d + count) % count : 0)); }, [count]);

  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      const tag = t?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable || t?.getAttribute?.('role') === 'slider') return;
      if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
      else if (ev.key === ' ' && tag !== 'BUTTON') { ev.preventDefault(); setPlaying((p: boolean) => !p); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [step]);

  const toggleCat = async (src: Src) => {
    const next = !show[src];
    setShow((s: Record<Src, boolean>) => ({ ...(s ?? {}), [src]: next }));
    if (!next || cats?.[src]?.stars?.length || !g) return;
    setCats((c: Record<Src, CatState | null>) => ({ ...(c ?? {}), [src]: { loading: true, stars: [] } }));
    try {
      const r = await fetch(`/api/catalog?ra=${g.ra}&dec=${g.dec}&fov=${summary?.fov ?? 5}&src=${src}`);
      const j = await r.json();
      setCats((c: Record<Src, CatState | null>) => ({ ...(c ?? {}), [src]: { loading: false, stars: (j?.stars ?? []) as CatStar[], error: r.ok ? undefined : (j?.error ?? 'Catalog unavailable'), count: j?.count ?? 0 } }));
    } catch (e) {
      console.error('catalog fetch failed', e);
      setCats((c: Record<Src, CatState | null>) => ({ ...(c ?? {}), [src]: { loading: false, stars: [], error: 'Catalog request failed' } }));
    }
  };

  const cur = epochs?.[epoch];
  const year = cur ? mjdToYear(cur.mjd) : 2025.9;

  const catMarks = useMemo(() => {
    if (!g) return [] as { src: Src; x: number; y: number; r: number; label: string }[];
    const out: { src: Src; x: number; y: number; r: number; label: string }[] = [];
    (['gaia', 'allwise'] as Src[]).forEach((src: Src) => {
      if (!show?.[src]) return;
      (cats?.[src]?.stars ?? []).forEach((s: CatStar) => {
        const from = src === 'gaia' ? 2016.0 : 2010.5;
        const [ra, dec] = s?.pmra != null && s?.pmdec != null ? propagate(s.ra, s.dec, [s.pmra, s.pmdec], from, year) : [s.ra, s.dec];
        const [x, y] = worldToGrid(g, ra, dec);
        if (x < -1 || y < -1 || x > n || y > n) return;
        const m = s?.mag ?? 18;
        const r = Math.min(4.5, Math.max(1.5, 4.5 - (m - 8) * 0.3));
        out.push({ src, x, y, r, label: `${src === 'gaia' ? 'Gaia DR3' : 'AllWISE'} ${s.id}${s.mag != null ? ` · ${src === 'gaia' ? 'G' : 'W1'}=${s.mag.toFixed(2)}` : ''}` });
      });
    });
    return out;
  }, [g, n, show, cats, year]);

  const trackPts = useMemo(() => {
    if (!g || !preset?.pm) return [] as [number, number][];
    return epochs.map((ep: EpochMeta) => {
      const [ra, dec] = propagate(preset.ra, preset.dec, preset.pm as [number, number], preset.refYear ?? 2025.9, mjdToYear(ep.mjd));
      return worldToGrid(g, ra, dec);
    });
  }, [g, preset, epochs]);

  const toGrid = (ev: React.MouseEvent): [number, number] | null => {
    const r = boxRef.current?.getBoundingClientRect?.();
    if (!r || !r.width) return null;
    return [((ev.clientX - r.left) / r.width) * n - 0.5, ((ev.clientY - r.top) / r.height) * n - 0.5];
  };

  const src = (e: number) => `/api/frame?key=${encodeURIComponent(summary?.key ?? '')}&e=${e}&mode=${mode}&band=${mode === 'rgb' ? 'all' : band}`;
  const loadedCount = epochs.filter((_: EpochMeta, e: number) => loaded?.[src(e)]).length;
  const c = (n - 1) / 2;
  const arcminPx = 60 / PIX_ARCSEC;
  const hoverWorld = hover && g ? gridToWorld(g, hover[0], hover[1]) : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg bg-secondary/60 p-1 shadow-sm" role="tablist" aria-label="Image math mode">
            {MODES.map((m: { id: Mode; label: string; hint: string }) => (
              <button
                key={m.id} role="tab" aria-selected={mode === m.id} title={m.hint} onClick={() => setMode(m.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${mode === m.id ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
            <select
              value={band} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setBand(e.target.value)} disabled={mode === 'rgb'}
              className="rounded-md bg-secondary/60 px-2 py-1.5 text-xs text-foreground shadow-sm outline-none focus:ring-1 focus:ring-primary disabled:opacity-40"
              aria-label="Detector band"
            >
              <option value="all">All bands (D1–D6)</option>
              {[1, 2, 3, 4, 5, 6].map((b: number) => (
                <option key={b} value={String(b)} disabled={!(summary?.bands ?? []).includes(b)}>
                  D{b} · {BANDS[b]?.[0]}–{BANDS[b]?.[1]} µm
                </option>
              ))}
            </select>
          </label>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Toggle on={reticle} onClick={() => setReticle((v: boolean) => !v)}><Crosshair className="h-3.5 w-3.5" />Reticle</Toggle>
            {trackPts.length > 0 && <Toggle on={track} onClick={() => setTrack((v: boolean) => !v)}><Navigation className="h-3.5 w-3.5" />PM track</Toggle>}
            <Toggle on={show.gaia} onClick={() => toggleCat('gaia')} color="#22d3ee">Gaia DR3{cats.gaia?.loading && <Loader2 className="h-3 w-3 animate-spin" />}</Toggle>
            <Toggle on={show.allwise} onClick={() => toggleCat('allwise')} color="#fb923c">AllWISE{cats.allwise?.loading && <Loader2 className="h-3 w-3 animate-spin" />}</Toggle>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[680px] overflow-hidden rounded-lg bg-black shadow-2xl shadow-primary/10 ring-1 ring-white/5">
          <div
            ref={boxRef} className="relative aspect-square w-full cursor-crosshair select-none"
            onMouseMove={(ev: React.MouseEvent) => setHover(toGrid(ev))} onMouseLeave={() => setHover(null)}
            onClick={(ev: React.MouseEvent) => { const p = toGrid(ev); if (p) onPick(p[0], p[1]); }}
          >
            {epochs.map((_: EpochMeta, e: number) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${e}-${mode}-${band}`} src={src(e)} alt={`SPHEREx epoch ${e + 1} ${mode} frame`} draggable={false}
                onLoad={() => setLoaded((l: Record<string, boolean>) => ({ ...(l ?? {}), [src(e)]: true }))}
                onError={() => console.error('frame failed to load', src(e))}
                className="pixelated absolute inset-0 h-full w-full" style={{ opacity: e === epoch ? 1 : 0 }}
              />
            ))}
            <svg viewBox={`-0.5 -0.5 ${n} ${n}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none">
              {reticle && (
                <g stroke="#f97316" strokeWidth={1.4} vectorEffect="non-scaling-stroke" opacity={0.85}>
                  {[[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]: number[], i: number) => (
                    <line key={i} x1={c + dx * n * 0.04} y1={c + dy * n * 0.04} x2={c + dx * n * 0.1} y2={c + dy * n * 0.1} vectorEffect="non-scaling-stroke" />
                  ))}
                  <circle cx={c} cy={c} r={n * 0.025} fill="none" vectorEffect="non-scaling-stroke" strokeDasharray="2 2" />
                </g>
              )}
              {catMarks.map((m: { src: Src; x: number; y: number; r: number; label: string }, i: number) => (
                <circle key={i} cx={m.x} cy={m.y} r={m.r} fill="none" stroke={m.src === 'gaia' ? '#22d3ee' : '#fb923c'} strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.8}>
                  <title>{m.label}</title>
                </circle>
              ))}
              {track && trackPts.length > 0 && (
                <g>
                  <polyline points={trackPts.map((p: [number, number]) => p.join(',')).join(' ')} fill="none" stroke="#a3e635" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" opacity={0.7} />
                  {trackPts.map((p: [number, number], i: number) => (
                    <circle key={i} cx={p[0]} cy={p[1]} r={i === epoch ? 3.2 : 0.7} fill={i === epoch ? 'none' : '#a3e635'} stroke="#a3e635" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                  ))}
                </g>
              )}
              {pick && (
                <g stroke="#facc15" fill="none" vectorEffect="non-scaling-stroke">
                  <circle cx={pick.x} cy={pick.y} r={1.6} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
                  <circle cx={pick.x} cy={pick.y} r={3.2} strokeWidth={0.8} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" opacity={0.7} />
                  <circle cx={pick.x} cy={pick.y} r={5.5} strokeWidth={0.8} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" opacity={0.7} />
                </g>
              )}
            </svg>
            <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-1 font-mono text-[11px] text-cyan-200 backdrop-blur">
              EPOCH {epoch + 1}/{count} · {cur?.utc?.slice(0, 10) ?? '—'}
            </div>
            <svg viewBox="0 0 44 44" className="pointer-events-none absolute right-2 top-2 h-11 w-11" aria-label="North up, East left">
              <g stroke="#cbd5e1" strokeWidth={1.2} fill="none"><path d="M36 36 V12 M36 36 H12" /><path d="M33 15 L36 11 L39 15 M15 33 L11 36 L15 39" /></g>
              <text x="36" y="8" fill="#cbd5e1" fontSize="9" textAnchor="middle" fontFamily="monospace">N</text>
              <text x="5" y="39" fill="#cbd5e1" fontSize="9" textAnchor="middle" fontFamily="monospace">E</text>
            </svg>
            <div className="pointer-events-none absolute bottom-2 right-2 flex flex-col items-center font-mono text-[10px] text-slate-300" style={{ width: `${(arcminPx / n) * 100}%` }}>
              <span className="mb-0.5 h-0.5 w-full bg-slate-200" />
              <span>1′</span>
            </div>
            {hoverWorld && (
              <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-[10px] text-slate-200 backdrop-blur">
                {hoverWorld[0].toFixed(5)}°, {hoverWorld[1].toFixed(5)}°
              </div>
            )}
            {loadedCount < count && (
              <div className="pointer-events-none absolute inset-x-0 bottom-10 mx-auto flex w-fit items-center gap-2 rounded bg-black/70 px-3 py-1 text-xs text-slate-200">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Rendering frames {loadedCount}/{count}
              </div>
            )}
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[680px] flex-wrap items-center gap-3 rounded-lg bg-card/80 p-3 shadow-md">
          <button onClick={() => step(-1)} className="rounded-md bg-secondary p-2 shadow-sm transition hover:bg-secondary/70" aria-label="Previous epoch"><SkipBack className="h-4 w-4" /></button>
          <button
            onClick={() => setPlaying((p: boolean) => !p)} disabled={count < 2}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow transition hover:bg-primary/85 disabled:opacity-40"
            aria-label={playing ? 'Pause blink' : 'Play blink'}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}{playing ? 'Pause' : 'Play'}
          </button>
          <button onClick={() => step(1)} className="rounded-md bg-secondary p-2 shadow-sm transition hover:bg-secondary/70" aria-label="Next epoch"><SkipForward className="h-4 w-4" /></button>
          <div className="min-w-[140px] flex-1">
            <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground"><span>Epoch scrubber</span><span className="font-mono">{epoch + 1} / {count}</span></div>
            <Slider value={[epoch]} min={0} max={Math.max(0, count - 1)} step={1} onValueChange={(v: number[]) => { setPlaying(false); setEpoch(v?.[0] ?? 0); }} aria-label="Epoch scrubber" />
          </div>
          <div className="w-32">
            <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground"><span className="flex items-center gap-1"><Gauge className="h-3 w-3" />Speed</span><span className="font-mono">{fps} FPS</span></div>
            <Slider value={[fps]} min={1} max={10} step={1} onValueChange={(v: number[]) => setFps(v?.[0] ?? 2)} aria-label="Frames per second" />
          </div>
        </div>
        <p className="text-center text-[11px] text-muted-foreground">
          <kbd className="rounded bg-secondary px-1">←</kbd> <kbd className="rounded bg-secondary px-1">→</kbd> step epochs · <kbd className="rounded bg-secondary px-1">Space</kbd> play/pause · click any source for aperture photometry
        </p>
      </div>

      <aside className="space-y-3">
        <div className="rounded-lg bg-card/80 p-4 shadow-md">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-primary" />Epoch {epoch + 1} metadata</h3>
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">MJD (mean)</dt><dd className="font-mono">{cur?.mjd?.toFixed?.(4) ?? '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">UTC</dt><dd className="font-mono">{cur?.utc?.replace('T', ' ')?.slice(0, 19) ?? '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Exposures stacked</dt><dd className="font-mono">{cur?.exposures ?? 0}</dd></div>
            <div>
              <dt className="mb-1 text-muted-foreground">Detector bands</dt>
              <dd className="flex flex-wrap gap-1">
                {[1, 2, 3, 4, 5, 6].map((b: number) => {
                  const k = cur?.perBand?.[String(b)] ?? cur?.perBand?.[`D${b}`] ?? 0;
                  return (
                    <span key={b} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${k ? 'bg-primary/15 text-cyan-200' : 'bg-secondary/50 text-muted-foreground/60'}`} title={`${BANDS[b]?.[0]}–${BANDS[b]?.[1]} µm`}>
                      D{b}×{k}
                    </span>
                  );
                })}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-2">
              <dt className="flex items-center gap-1 text-muted-foreground"><Flag className="h-3 w-3" />FLAGS</dt>
              <dd className={`text-right font-medium ${(cur?.flagFrac ?? 0) > 0.1 ? 'text-amber-300' : 'text-emerald-300'}`}>
                {cur?.flagStatus ?? '—'}
                <span className="block font-mono text-[10px] text-muted-foreground">{((cur?.flagFrac ?? 0) * 100).toFixed(1)}% pixels masked</span>
              </dd>
            </div>
            {(cur?.topFlags?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1">
                {(cur?.topFlags ?? []).map((f: string) => <span key={f} className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">{f}</span>)}
              </div>
            )}
          </dl>
        </div>
        <div className="rounded-lg bg-card/80 p-4 shadow-md">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Telescope className="h-4 w-4 text-primary" />Field</h3>
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Centre</dt><dd className="text-right font-mono text-[11px]">{g ? fmtSexa(g.ra, g.dec) : '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Field of view</dt><dd className="font-mono">{summary?.fov}′ · {n}×{n} px</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Pixel scale</dt><dd className="font-mono">{PIX_ARCSEC}″</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Epochs · exposures</dt><dd className="font-mono">{count} · {summary?.exposureCount ?? 0}</dd></div>
            {(['gaia', 'allwise'] as Src[]).filter((s: Src) => show?.[s] && cats?.[s] && !cats?.[s]?.loading).map((s: Src) => (
              <div key={s} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{s === 'gaia' ? 'Gaia DR3' : 'AllWISE'}</dt>
                <dd className={`font-mono ${cats?.[s]?.error ? 'text-amber-300' : ''}`}>{cats?.[s]?.error ?? `${cats?.[s]?.stars?.length ?? 0} shown`}</dd>
              </div>
            ))}
          </dl>
          {mode === 'diff' && <p className="mt-3 rounded bg-primary/10 p-2 text-[11px] text-cyan-100"><Sparkles className="mr-1 inline h-3 w-3" />{epoch === 0 ? 'Epoch 1 is the reference – step forward to see changes.' : 'Bright = brighter than Epoch 1, dark = fainter. Moving sources leave dark/bright pairs.'}</p>}
          {mode === 'rgb' && <p className="mt-3 rounded bg-accent/10 p-2 text-[11px] text-orange-100">Red D5–D6 (3.8–5.0 µm) · Green D3–D4 (1.6–3.8 µm) · Blue D1–D2 (0.75–1.6 µm). Cold brown dwarfs glow red.</p>}
          {track && trackPts.length > 0 && <p className="mt-3 rounded bg-lime-400/10 p-2 text-[11px] text-lime-100">Green ring = predicted position of {preset?.name} at this epoch from its catalogued proper motion.</p>}
        </div>
      </aside>
    </div>
  );
}
