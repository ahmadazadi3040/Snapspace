export const PIX_ARCSEC = 6.15;
export const BANDS: Record<number, [number, number]> = {
  1: [0.75, 1.11], 2: [1.11, 1.64], 3: [1.64, 2.42], 4: [2.42, 3.82], 5: [3.82, 4.42], 6: [4.42, 5.0],
};

export interface Grid { ra: number; dec: number; n: number; scale: number }
export interface EpochMeta {
  index: number; mjd: number; utc: string; bands: number[]; exposures: number;
  perBand: Record<string, number>; flagFrac: number; flagStatus: string; topFlags: string[];
}
export interface DatasetSummary {
  key: string; mode: 'live' | 'demo'; reason?: string; grid: Grid; fov: number;
  epochs: EpochMeta[]; exposureCount: number; bands: number[]; durationMs: number;
}
export interface SpecPoint { wavelength: number; flux: number; epoch: number; band: number; mjd: number }
export interface LcPoint { epoch: number; mjd: number; utc: string; [band: string]: number | string }
export interface CatStar { id: string; ra: number; dec: number; mag: number | null; pmra: number | null; pmdec: number | null }
export interface PhotResult { x: number; y: number; ra: number; dec: number; spectrum: SpecPoint[]; lightcurve: LcPoint[]; unit: string }
export interface JobStatus { key: string; status: 'running' | 'ready' | 'error'; progress: number; message: string; summary?: DatasetSummary; error?: string }
/** Grid ↔ display: pixel index i has its centre at i; the PNG spans [-0.5, n-0.5]. */
export const mjdToIso = (mjd: number) => new Date((mjd - 40587) * 86400000).toISOString();

export interface Preset { name: string; ra: number; dec: number; note: string; pm?: [number, number]; refYear?: number; catalog?: string }
/** pm = [pmRA*cos(dec), pmDec] in mas/yr, positions valid at refYear (used to draw the predicted track per epoch). */
export const PRESETS: Preset[] = [
  { name: "Barnard's Star", ra: 269.44631, dec: 4.76763, note: 'High proper-motion red dwarf (10.4″/yr)', pm: [-801.6, 10362.4], refYear: 2025.9 },
  { name: 'Epsilon Indi B', ra: 331.09624, dec: -56.80053, note: 'Binary brown dwarf system', pm: [3966.7, -2536.2], refYear: 2025.9 },
  { name: 'WISE 0855', ra: 133.76001, dec: -7.2421, note: 'Coldest known brown dwarf (8.1″/yr) – centred on its 2025.9 position', pm: [-8123.7, 673.2], refYear: 2025.9, catalog: '08h55m10.831s -07d14m42.53s (WISE discovery epoch, ~2010)' },
  { name: 'RW Aurigae', ra: 76.956408, dec: 30.401408, note: 'Young variable T Tauri star' },
  { name: 'R Draconis', ra: 248.167433, dec: 66.755019, note: 'Mira-type long-period variable' },
];
export const mjdToYear = (mjd: number) => 2000 + (mjd - 51544.5) / 365.25;
/** Propagate a position by proper motion (mas/yr) from refYear to the given year. */
export function propagate(ra: number, dec: number, pm: [number, number], fromYear: number, toYear: number): [number, number] {
  const dt = toYear - fromYear;
  return [ra + (pm[0] * dt) / 3.6e6 / Math.cos((dec * Math.PI) / 180), dec + (pm[1] * dt) / 3.6e6];
}

const D2R = Math.PI / 180;
/** Display grid: col left→right (east left), row top→bottom (north up). */
export function gridToWorld(g: Grid, px: number, py: number): [number, number] {
  const c = (g.n - 1) / 2;
  const xi = -(px - c) * g.scale * D2R, eta = -(py - c) * g.scale * D2R;
  const d0 = g.dec * D2R, den = Math.cos(d0) - eta * Math.sin(d0);
  const ra = g.ra + Math.atan2(xi, den) / D2R;
  const dec = Math.atan2(eta * Math.cos(d0) + Math.sin(d0), Math.sqrt(xi * xi + den * den)) / D2R;
  return [((ra % 360) + 360) % 360, dec];
}
export function worldToGrid(g: Grid, ra: number, dec: number): [number, number] {
  const a = ra * D2R, d = dec * D2R, a0 = g.ra * D2R, d0 = g.dec * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc / D2R;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc / D2R;
  const c = (g.n - 1) / 2;
  return [c - xi / g.scale, c - eta / g.scale];
}

export function parseCoords(input: string): { ra: number; dec: number } | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  const dec2 = s.match(/^([+-]?\d+(?:\.\d+)?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?)$/);
  if (dec2) {
    const ra = parseFloat(dec2[1]), dec = parseFloat(dec2[2]);
    return ra >= 0 && ra < 360 && Math.abs(dec) <= 90 ? { ra, dec } : null;
  }
  const nums = s.replace(/[hdms:°′″'",]/gi, ' ').trim().split(/\s+/);
  if (nums.length !== 6) return null;
  const [h, m, sec, dd, dm, ds] = nums.map((v: string) => parseFloat(v));
  if ([h, m, sec, dd, dm, ds].some((v: number) => Number.isNaN(v))) return null;
  const sign = nums[3].startsWith('-') ? -1 : 1;
  const ra = (h + m / 60 + sec / 3600) * 15;
  const dec = sign * (Math.abs(dd) + dm / 60 + ds / 3600);
  return ra >= 0 && ra < 360 && Math.abs(dec) <= 90 ? { ra, dec } : null;
}

export function fmtSexa(ra: number, dec: number): string {
  const h = ra / 15, hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
  const sg = dec < 0 ? '-' : '+', ad = Math.abs(dec), dd = Math.floor(ad), dm = Math.floor((ad - dd) * 60), dsec = ((ad - dd) * 60 - dm) * 60;
  const p = (v: number, w: number, f = 0) => v.toFixed(f).padStart(w, '0');
  return `${p(hh, 2)}h${p(mm, 2)}m${p(ss, 6, 3)}s ${sg}${p(dd, 2)}d${p(dm, 2)}m${p(dsec, 5, 2)}s`;
}
