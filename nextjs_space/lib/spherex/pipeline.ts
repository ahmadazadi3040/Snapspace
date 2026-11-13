import fs from 'fs';
import path from 'path';
import { TanSip, fitAffine, affineResample, percentiles, asinhStretch, encodePng, type Hdu } from './core';
import { PIX_ARCSEC, gridToWorld, mjdToIso, type Grid, type DatasetSummary, type EpochMeta, type JobStatus, type SpecPoint, type LcPoint, type PhotResult } from './shared';
import { querySia, fetchCutout, pool, type SiaRow } from './irsa';
import { generateDemo, type ExpRecord } from './demo';
import WAVE from './wave-tables.json';
import { prisma } from '@/lib/db';

const ROOT = process.env.SPHEREX_CACHE_DIR ?? '/tmp/spherex_cache';
const MAX_EXPOSURES = 144;
const FLAG_NAMES: Record<number, string> = { 0: 'TRANSIENT', 1: 'OVERFLOW', 2: 'SUR_ERROR', 6: 'NONFUNC', 7: 'DICHROIC', 9: 'MISSING_DATA', 10: 'HOT', 11: 'COLD', 14: 'PHANMISS', 15: 'NONLINEAR', 17: 'PERSIST', 19: 'OUTLIER', 20: 'CROSSTALK', 21: 'SOURCE', 22: 'GHOST', 23: 'GHOST_FPA', 24: 'GHOST_EXT', 25: 'STREAK', 26: 'BLOOM', 27: 'SNOWBALL', 28: 'HALO' };
const BAD_BITS = [0, 1, 2, 6, 9, 10, 11, 15, 17, 19].reduce((m: number, b: number) => m | (1 << b), 0);

interface ExpMeta { band: number; mjd: number; epoch: number; wl: number; flagFrac: number; det?: ExpRecord['det'] }
interface Loaded { summary: DatasetSummary; exps: ExpMeta[]; expData: Float32Array[]; stacks: (Float32Array | null)[][]; norm: number[] }

const G = globalThis as unknown as { __spxJobs?: Map<string, JobStatus & { t: number }>; __spxData?: Map<string, Loaded>; __spxPng?: Map<string, Buffer>; __spxLim?: Map<string, number[]> };
const jobs = (G.__spxJobs ??= new Map());
const loaded = (G.__spxData ??= new Map());
const pngCache = (G.__spxPng ??= new Map());
const limCache = (G.__spxLim ??= new Map());

export function makeGrid(ra: number, dec: number, fov: number): Grid {
  let n = Math.round((fov * 60) / PIX_ARCSEC);
  if (n % 2 === 0) n += 1;
  return { ra, dec, n, scale: PIX_ARCSEC / 3600 };
}
export const datasetKey = (mode: 'live' | 'demo', ra: number, dec: number, fov: number) => `${mode}_${ra.toFixed(5)}_${dec.toFixed(5)}_${fov}`.replace(/[^\w.-]/g, '');
const dirOf = (key: string) => path.join(/*turbopackIgnore: true*/ ROOT, key);

// ---------- wavelength lookup (per-detector WCS-WAVE tables) ----------
type WaveTab = { x: number[]; y: number[]; wl: number[][] };
function interpIdx(arr: number[], v: number): [number, number] {
  if (v <= (arr[0] ?? 0)) return [0, 0];
  for (let i = 0; i < arr.length - 1; i++) { const a = arr[i] ?? 0, b = arr[i + 1] ?? 0; if (v <= b) return [i, b > a ? (v - a) / (b - a) : 0]; }
  return [arr.length - 2, 1];
}
function waveAt(band: number, det: NonNullable<ExpRecord['det']>, gx: number, gy: number): number {
  const t = (WAVE as Record<string, WaveTab>)[String(band)];
  if (!t) return NaN;
  const A = det.A;
  const x = (A[0] ?? 0) * gx + (A[1] ?? 0) * gy + (A[2] ?? 0), y = (A[3] ?? 0) * gx + (A[4] ?? 0) * gy + (A[5] ?? 0);
  const dx = x + 1 - det.crpixW[0] + det.crvalW[0], dy = y + 1 - det.crpixW[1] + det.crvalW[1];
  const [ix, fx] = interpIdx(t.x, dx), [iy, fy] = interpIdx(t.y, dy);
  const v = (r: number, c: number) => t.wl?.[r]?.[c] ?? NaN;
  return v(iy, ix) * (1 - fx) * (1 - fy) + v(iy, ix + 1) * fx * (1 - fy) + v(iy + 1, ix) * (1 - fx) * fy + v(iy + 1, ix + 1) * fx * fy;
}

// ---------- live exposure processing ----------
function processExposure(h: Record<string, Hdu>, row: SiaRow, grid: Grid): ExpRecord | null {
  const img = h.IMAGE;
  if (!img?.data) return null;
  const wcs = new TanSip(img.header);
  const n = grid.n, pairs: [number, number, number, number][] = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    const gx = (i / 4) * (n - 1), gy = (j / 4) * (n - 1);
    const [r, d] = gridToWorld(grid, gx, gy);
    const [x, y] = wcs.world2pix(r, d);
    pairs.push([gx, gy, x, y]);
  }
  const A = fitAffine(pairs);
  const sci = new Float32Array(img.data);
  const zo = h.ZODI?.data;
  if (zo && zo.length === sci.length) for (let i = 0; i < sci.length; i++) sci[i] -= zo[i] ?? 0;
  const data = affineResample(sci, img.w, img.h, A, n);
  const fl = h.FLAGS?.idata;
  const bitCount = new Map<number, number>();
  let bad = 0, valid = 0;
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
    const i = py * n + px;
    if (!Number.isFinite(data[i])) continue;
    valid++;
    if (!fl) continue;
    const sx = Math.round((A[0] ?? 0) * px + (A[1] ?? 0) * py + (A[2] ?? 0)), sy = Math.round((A[3] ?? 0) * px + (A[4] ?? 0) * py + (A[5] ?? 0));
    if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
    const f = fl[sy * img.w + sx] ?? 0;
    if (f) for (const b of Object.keys(FLAG_NAMES)) { const bit = Number(b); if (f & (1 << bit)) bitCount.set(bit, (bitCount.get(bit) ?? 0) + 1); }
    if (f & BAD_BITS) { data[i] = NaN; bad++; }
  }
  if (valid < n * n * 0.25) return null;
  const med = percentiles([data], [50])[0] ?? 0;
  for (let i = 0; i < data.length; i++) data[i] -= med;
  const flags = [...bitCount.entries()].sort((a: [number, number], b: [number, number]) => b[1] - a[1]).slice(0, 4).map((e: [number, number]) => FLAG_NAMES[e[0]] ?? String(e[0]));
  const hd = img.header;
  const det = { A, crpixW: [Number(hd.CRPIX1W ?? 0), Number(hd.CRPIX2W ?? 0)] as [number, number], crvalW: [Number(hd.CRVAL1W ?? 1), Number(hd.CRVAL2W ?? 1)] as [number, number] };
  const c = (n - 1) / 2;
  const wl = waveAt(row.band, det, c, c);
  const mjd = Number(hd['MJD-AVG'] ?? row.mjd);
  return { band: row.band, mjd: Number.isFinite(mjd) ? mjd : row.mjd, wl, flagFrac: valid ? bad / valid : 0, flags, data, det };
}

/** One epoch per survey pass: split on gaps > 45 d; continuous coverage (near the ecliptic poles) is cut into <= 75 d windows. */
function epochIndex(mjds: number[]): number[] {
  const order = mjds.map((m: number, i: number) => [m, i] as [number, number]).sort((a: [number, number], b: [number, number]) => a[0] - b[0]);
  const lab = new Array<number>(mjds.length).fill(0);
  let e = 0, start = order[0]?.[0] ?? 0, prev = start;
  for (const [m, i] of order) {
    if (m - prev > 45 || m - start > 75) { e++; start = m; }
    lab[i] = e; prev = m;
  }
  return lab;
}

function selectRows(rows: SiaRow[]): SiaRow[] {
  const lab = epochIndex(rows.map((r: SiaRow) => r.mjd));
  const nE = Math.max(...lab, 0) + 1;
  const keepEpochs = nE > 16 ? new Set(Array.from({ length: 16 }, (_: unknown, i: number) => Math.round((i * (nE - 1)) / 15))) : null;
  const groups = new Map<string, SiaRow[]>();
  rows.forEach((r: SiaRow, i: number) => { const e = lab[i] ?? 0; if (keepEpochs && !keepEpochs.has(e)) return; const k = `${e}_${r.band}`; groups.set(k, [...(groups.get(k) ?? []), r]); });
  const per = Math.max(2, Math.min(10, Math.floor(MAX_EXPOSURES / Math.max(1, groups.size))));
  const out: SiaRow[] = [];
  groups.forEach((g: SiaRow[]) => {
    g.sort((a: SiaRow, b: SiaRow) => a.mjd - b.mjd);
    if (g.length <= per) out.push(...g);
    else for (let i = 0; i < per; i++) { const r = g[Math.round((i * (g.length - 1)) / (per - 1))]; if (r) out.push(r); }
  });
  return out;
}

// ---------- stacking & persistence ----------
function nanMedianStack(arrs: Float32Array[], n2: number): Float32Array {
  const out = new Float32Array(n2).fill(NaN);
  const buf: number[] = [];
  for (let i = 0; i < n2; i++) {
    buf.length = 0;
    for (const a of arrs) { const v = a[i] ?? NaN; if (Number.isFinite(v)) buf.push(v); }
    if (!buf.length) continue;
    if (buf.length === 2) { const a = buf[0] ?? 0, b = buf[1] ?? 0; out[i] = Math.abs(a) < Math.abs(b) ? a : b; continue; } // reject single-frame hits
    buf.sort((x: number, y: number) => x - y);
    const m = buf.length >> 1;
    out[i] = buf.length % 2 ? (buf[m] ?? NaN) : ((buf[m - 1] ?? 0) + (buf[m] ?? 0)) / 2;
  }
  return out;
}

function assemble(key: string, mode: 'live' | 'demo', grid: Grid, fov: number, recs: ExpRecord[], t0: number, reason?: string): Loaded {
  const lab = epochIndex(recs.map((r: ExpRecord) => r.mjd));
  const nE = Math.max(...lab, 0) + 1, n2 = grid.n * grid.n;
  const exps: ExpMeta[] = recs.map((r: ExpRecord, i: number) => ({ band: r.band, mjd: r.mjd, epoch: lab[i] ?? 0, wl: r.wl, flagFrac: r.flagFrac, det: r.det }));
  const stacks: (Float32Array | null)[][] = [];
  const epochs: EpochMeta[] = [];
  for (let e = 0; e < nE; e++) {
    const idx = recs.map((_: ExpRecord, i: number) => i).filter((i: number) => lab[i] === e);
    const row: (Float32Array | null)[] = [];
    const perBand: Record<string, number> = {};
    for (let b = 1; b <= 6; b++) {
      const sel = idx.filter((i: number) => recs[i]?.band === b);
      if (sel.length) perBand[`D${b}`] = sel.length;
      row.push(sel.length ? nanMedianStack(sel.map((i: number) => recs[i]?.data ?? new Float32Array(n2)), n2) : null);
    }
    stacks.push(row);
    const mjd = idx.reduce((s: number, i: number) => s + (recs[i]?.mjd ?? 0), 0) / Math.max(1, idx.length);
    const flagFrac = idx.reduce((s: number, i: number) => s + (recs[i]?.flagFrac ?? 0), 0) / Math.max(1, idx.length);
    const fc = new Map<string, number>();
    idx.forEach((i: number) => (recs[i]?.flags ?? []).forEach((f: string) => fc.set(f, (fc.get(f) ?? 0) + 1)));
    epochs.push({
      index: e, mjd, utc: mjdToIso(mjd), bands: Object.keys(perBand).map((k: string) => Number(k.slice(1))), exposures: idx.length, perBand, flagFrac,
      flagStatus: flagFrac < 0.02 ? 'Clean' : flagFrac < 0.12 ? 'Minor flags' : 'Heavily flagged',
      topFlags: [...fc.entries()].sort((a: [string, number], b: [string, number]) => b[1] - a[1]).slice(0, 4).map((x: [string, number]) => x[0]),
    });
  }
  const norm = [1, 2, 3, 4, 5, 6].map((b: number) => {
    const arrs = stacks.map((r: (Float32Array | null)[]) => r[b - 1]).filter((a: Float32Array | null | undefined): a is Float32Array => !!a);
    if (!arrs.length) return 1;
    const [p50, p995] = percentiles(arrs, [50, 99.5]);
    return Math.max(1e-6, (p995 ?? 1) - (p50 ?? 0));
  });
  const bands = [...new Set(recs.map((r: ExpRecord) => r.band))].sort();
  const summary: DatasetSummary = { key, mode, reason, grid, fov, epochs, exposureCount: recs.length, bands, durationMs: Date.now() - t0 };
  return { summary, exps, expData: recs.map((r: ExpRecord) => r.data), stacks, norm };
}

function save(L: Loaded) {
  try {
    const d = dirOf(L.summary.key);
    fs.mkdirSync(d, { recursive: true });
    const n2 = L.summary.grid.n ** 2;
    const present = L.stacks.map((r: (Float32Array | null)[]) => r.map((a: Float32Array | null) => !!a));
    const flat = (arrs: Float32Array[]) => Buffer.concat(arrs.map((a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
    fs.writeFileSync(path.join(d, 'exp.bin'), flat(L.expData));
    fs.writeFileSync(path.join(d, 'stack.bin'), flat(L.stacks.flat().map((a: Float32Array | null) => a ?? new Float32Array(n2))));
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ summary: L.summary, exps: L.exps, norm: L.norm, present }));
  } catch (e) { console.warn('cache write failed', e); }
}

function readF32(file: string, n2: number, count: number): Float32Array[] {
  const b = fs.readFileSync(file);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return Array.from({ length: count }, (_: unknown, i: number) => new Float32Array(ab, i * n2 * 4, n2));
}

export function getDataset(key: string): Loaded | null {
  const m = loaded.get(key);
  if (m) return m;
  try {
    const d = dirOf(key);
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')) as { summary: DatasetSummary; exps: ExpMeta[]; norm: number[]; present: boolean[][] };
    const n2 = meta.summary.grid.n ** 2;
    const expData = readF32(path.join(d, 'exp.bin'), n2, meta.exps.length);
    const flat = readF32(path.join(d, 'stack.bin'), n2, meta.present.length * 6);
    const stacks = meta.present.map((r: boolean[], e: number) => r.map((p: boolean, b: number) => (p ? flat[e * 6 + b] ?? null : null)));
    const L: Loaded = { summary: meta.summary, exps: meta.exps, expData, stacks, norm: meta.norm };
    remember(key, L);
    return L;
  } catch { return null; }
}

function remember(key: string, L: Loaded) {
  loaded.set(key, L);
  if (loaded.size > 10) { const first = loaded.keys().next().value; if (first) loaded.delete(first); }
}

async function logSearch(s: DatasetSummary, key: string) {
  try {
    await prisma.searchLog.upsert({
      where: { cacheKey: key },
      create: { cacheKey: key, ra: s.grid.ra, dec: s.grid.dec, fov: s.fov, dataMode: s.mode, epochCount: s.epochs.length, exposureCount: s.exposureCount, durationMs: s.durationMs },
      update: { hits: { increment: 1 }, dataMode: s.mode, epochCount: s.epochs.length, exposureCount: s.exposureCount },
    });
  } catch (e) { console.warn('search log failed', (e as Error)?.message); }
}

function buildDemo(ra: number, dec: number, fov: number, reason?: string): Loaded {
  const key = datasetKey('demo', ra, dec, fov);
  const cached = getDataset(key);
  if (cached) return reason ? { ...cached, summary: { ...cached.summary, reason } } : cached;
  const t0 = Date.now();
  const grid = makeGrid(ra, dec, fov);
  const L = assemble(key, 'demo', grid, fov, generateDemo(ra, dec, grid.n, grid.scale), t0, reason);
  remember(key, L);
  save(L);
  return L;
}

async function buildLive(job: JobStatus, ra: number, dec: number, fov: number): Promise<Loaded> {
  const t0 = Date.now();
  job.message = 'Querying IRSA SIA2 (spherex_dr1)…';
  job.progress = 0.03;
  const rows = await querySia(ra, dec);
  if (!rows.length) throw Object.assign(new Error('No SPHEREx DR1 coverage at this position yet'), { noCoverage: true });
  const sel = selectRows(rows);
  const grid = makeGrid(ra, dec, fov);
  const size = (fov / 60) * 1.5 + 0.008;
  let done = 0;
  job.message = `Found ${rows.length} SPHEREx images · fetching ${sel.length} cutouts`;
  const recs = await pool(sel, 16, async (row: SiaRow) => {
    const h = await fetchCutout(row.url, ra, dec, size);
    done++;
    job.progress = 0.06 + (0.86 * done) / sel.length;
    job.message = `Downloading & reprojecting cutouts ${done}/${sel.length}`;
    return processExposure(h, row, grid);
  });
  const good = recs.filter((r: ExpRecord | null): r is ExpRecord => !!r);
  if (good.length < 3) throw new Error(`Only ${good.length} usable cutouts retrieved from IRSA`);
  job.message = 'Stacking epochs…';
  job.progress = 0.95;
  const L = assemble(datasetKey('live', ra, dec, fov), 'live', grid, fov, good, t0);
  remember(L.summary.key, L);
  save(L);
  return L;
}

/** Start (or return) the dataset job for a pointing. The client polls until status === 'ready'. */
export function startJob(ra: number, dec: number, fov: number, demo: boolean): JobStatus {
  const mode = demo ? 'demo' : 'live';
  const key = datasetKey(mode, ra, dec, fov);
  const existing = jobs.get(key);
  if (existing && (existing.status === 'running' || (existing.status === 'ready' && Date.now() - existing.t < 15 * 60000))) return existing;
  const cached = getDataset(key);
  if (cached) {
    void logSearch(cached.summary, key);
    return { key, status: 'ready', progress: 1, message: 'Loaded from cache', summary: cached.summary };
  }
  const job: JobStatus & { t: number } = { key, status: 'running', progress: 0, message: 'Starting…', t: Date.now() };
  jobs.set(key, job);
  if (jobs.size > 200) { const first = jobs.keys().next().value; if (first) jobs.delete(first); }
  (async () => {
    try {
      let L: Loaded;
      if (demo) { job.message = 'Synthesising demo sky…'; L = buildDemo(ra, dec, fov); }
      else {
        try { L = await buildLive(job, ra, dec, fov); }
        catch (e) {
          const err = e as Error & { noCoverage?: boolean };
          console.warn('live pipeline failed, falling back to demo:', err?.message);
          L = buildDemo(ra, dec, fov, err?.noCoverage ? err.message : `IRSA unavailable (${err?.message ?? 'error'}) – showing simulated data`);
        }
      }
      job.summary = L.summary; job.progress = 1; job.message = 'Ready'; job.status = 'ready'; job.t = Date.now();
      void logSearch(L.summary, key);
    } catch (e) {
      job.status = 'error'; job.error = (e as Error)?.message ?? 'Pipeline failed'; job.message = job.error; job.t = Date.now();
    }
  })();
  return job;
}

// ---------- rendering ----------
export type Mode = 'normal' | 'diff' | 'rgb';
function composite(L: Loaded, e: number, bands: number[]): Float32Array | null {
  const row = L.stacks[e];
  if (!row) return null;
  const n2 = L.summary.grid.n ** 2;
  const out = new Float32Array(n2).fill(NaN);
  const have = bands.filter((b: number) => !!row[b - 1]);
  if (!have.length) return null;
  for (let i = 0; i < n2; i++) {
    let s = 0, k = 0;
    for (const b of have) { const v = row[b - 1]?.[i] ?? NaN; if (Number.isFinite(v)) { s += v / (L.norm[b - 1] ?? 1); k++; } }
    if (k) out[i] = s / k;
  }
  return fillMasked(out, L.summary.grid.n);
}
/** Display-only: masked pixels (e.g. saturated cores) take the max of their finite neighbours. */
function fillMasked(a: Float32Array, n: number): Float32Array {
  for (let pass = 0; pass < 2; pass++) {
    const src = new Float32Array(a);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (Number.isFinite(src[y * n + x])) continue;
      let m = -Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const v = src[yy * n + xx] ?? NaN;
        if (Number.isFinite(v) && v > m) m = v;
      }
      if (m > -Infinity) a[y * n + x] = m;
    }
  }
  return a;
}
const bandSet = (band: string) => (band === 'all' ? [1, 2, 3, 4, 5, 6] : [Number(band)].filter((b: number) => b >= 1 && b <= 6));

function limits(L: Loaded, id: string, make: () => number[]): number[] {
  const k = `${L.summary.key}|${id}`;
  const c = limCache.get(k);
  if (c) return c;
  const v = make();
  limCache.set(k, v);
  if (limCache.size > 500) { const f = limCache.keys().next().value; if (f) limCache.delete(f); }
  return v;
}

export function renderFrame(L: Loaded, e: number, mode: Mode, band: string): Buffer | null {
  const ck = `${L.summary.key}|${e}|${mode}|${band}`;
  const hit = pngCache.get(ck);
  if (hit) return hit;
  const n = L.summary.grid.n, n2 = n * n, nE = L.stacks.length;
  if (e < 0 || e >= nE) return null;
  const rgb = new Uint8Array(n2 * 3);
  const bg = [6, 9, 18];
  if (mode === 'rgb') {
    const chans = [[5, 6], [3, 4], [1, 2]];
    chans.forEach((bs: number[], ci: number) => {
      const all = Array.from({ length: nE }, (_: unknown, i: number) => composite(L, i, bs)).filter((a: Float32Array | null): a is Float32Array => !!a);
      const [lo, hi] = limits(L, `rgb${ci}`, () => percentiles(all, [30, 99.5])); // darker sky floor keeps the noisier long bands from tinting the background
      const img = composite(L, e, bs);
      for (let i = 0; i < n2; i++) { const v = img?.[i] ?? NaN; rgb[i * 3 + ci] = Number.isFinite(v) ? Math.round(255 * asinhStretch(v, lo ?? 0, hi ?? 1)) : (bg[ci] ?? 0); }
    });
  } else {
    const bs = bandSet(band);
    const base = composite(L, 0, bs);
    const img = composite(L, e, bs);
    if (mode === 'normal') {
      const [lo, hi] = limits(L, `n${band}`, () => percentiles(Array.from({ length: nE }, (_: unknown, i: number) => composite(L, i, bs)).filter((a: Float32Array | null): a is Float32Array => !!a), [1, 99.5]));
      for (let i = 0; i < n2; i++) {
        const v = img?.[i] ?? NaN;
        if (!Number.isFinite(v)) { rgb.set(bg, i * 3); continue; }
        const s = asinhStretch(v, lo ?? 0, hi ?? 1);
        rgb[i * 3] = Math.round(255 * Math.pow(s, 1.02)); rgb[i * 3 + 1] = Math.round(250 * s); rgb[i * 3 + 2] = Math.round(240 * Math.pow(s, 0.96) + 6 * (1 - s));
      }
    } else {
      const [amp] = limits(L, `d${band}`, () => {
        const ds: Float32Array[] = [];
        for (let k = 1; k < nE; k++) { const a = composite(L, k, bs); if (!a || !base) continue; const d = new Float32Array(n2); for (let i = 0; i < n2; i++) d[i] = Math.abs((a[i] ?? NaN) - (base[i] ?? NaN)); ds.push(d); }
        return percentiles(ds, [99.5]);
      });
      for (let i = 0; i < n2; i++) {
        const d = (img?.[i] ?? NaN) - (base?.[i] ?? NaN);
        if (!Number.isFinite(d)) { rgb.set(bg, i * 3); continue; }
        const s = asinhStretch(Math.abs(d), 0, amp || 1, 0.15);
        const col = d > 0 ? [255, 150, 40] : [40, 200, 255];
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round((bg[c] ?? 0) * (1 - s) + (col[c] ?? 0) * s);
      }
    }
  }
  const ep = L.summary.epochs[e];
  const png = encodePng(rgb, n, { Software: 'SPHEREx Blink', Mode: mode, Band: band, Epoch: String(e), MJD: ep ? ep.mjd.toFixed(4) : '', DataMode: L.summary.mode });
  pngCache.set(ck, png);
  if (pngCache.size > 800) { const f = pngCache.keys().next().value; if (f) pngCache.delete(f); }
  return png;
}

// ---------- aperture photometry ----------
function aperture(a: Float32Array | null | undefined, n: number, x: number, y: number, r = 1.6, rin = 3.2, rout = 5.5): number | null {
  if (!a) return null;
  const ann: number[] = [];
  const ap: number[] = [];
  let apTotal = 0;
  const R = Math.ceil(rout);
  for (let py = Math.floor(y - R); py <= Math.ceil(y + R); py++) for (let px = Math.floor(x - R); px <= Math.ceil(x + R); px++) {
    const d = Math.hypot(px - x, py - y);
    const inside = px >= 0 && py >= 0 && px < n && py < n;
    if (d <= r) apTotal++;
    if (!inside) continue;
    const v = a[py * n + px] ?? NaN;
    if (!Number.isFinite(v)) continue;
    if (d <= r) ap.push(v); else if (d >= rin && d <= rout) ann.push(v);
  }
  if (!ap.length || ap.length < apTotal * 0.5) return null;
  ann.sort((p: number, q: number) => p - q);
  const bgv = ann.length >= 5 ? (ann[ann.length >> 1] ?? 0) : 0;
  const sum = ap.reduce((s: number, v: number) => s + (v - bgv), 0) * (apTotal / ap.length);
  return sum;
}

export function photometry(L: Loaded, x: number, y: number): PhotResult {
  const g = L.summary.grid, n = g.n;
  const toMjy = ((g.scale * Math.PI) / 180) ** 2 * 1e9; // MJy/sr * sr -> mJy
  const [ra, dec] = gridToWorld(g, x, y);
  const spectrum: SpecPoint[] = [];
  L.exps.forEach((m: ExpMeta, i: number) => {
    const f = aperture(L.expData[i], n, x, y);
    if (f === null) return;
    const wl = m.det ? waveAt(m.band, m.det, x, y) : m.wl;
    if (!Number.isFinite(wl)) return;
    spectrum.push({ wavelength: +wl.toFixed(4), flux: +(f * toMjy).toFixed(4), epoch: m.epoch, band: m.band, mjd: +m.mjd.toFixed(4) });
  });
  spectrum.sort((a: SpecPoint, b: SpecPoint) => a.wavelength - b.wavelength);
  const lightcurve: LcPoint[] = L.summary.epochs.map((ep: EpochMeta, e: number) => {
    const p: LcPoint = { epoch: e, mjd: +ep.mjd.toFixed(3), utc: ep.utc.slice(0, 10) };
    for (let b = 1; b <= 6; b++) { const f = aperture(L.stacks[e]?.[b - 1], n, x, y); if (f !== null) p[`D${b}`] = +(f * toMjy).toFixed(4); }
    return p;
  });
  return { x, y, ra, dec, spectrum, lightcurve, unit: 'mJy' };
}
