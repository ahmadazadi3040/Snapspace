import { BANDS } from './shared';

/** One reprojected, background-subtracted exposure on the common display grid. */
export interface ExpRecord {
  band: number; mjd: number; wl: number; flagFrac: number; flags: string[]; data: Float32Array;
  det?: { A: number[]; crpixW: [number, number]; crvalW: [number, number] };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Src { x: number; y: number; vx: number; vy: number; sed: (wl: number) => number; vary?: (mjd: number) => number; window?: [number, number] }

export const DEMO_EPOCHS = [60800.4, 60985.7, 61168.2, 61352.9];
const T_REF = 61077;

/** Synthetic SPHEREx-like multi-epoch field: field stars, a cold brown dwarf, a high-PM star, a Mira and an asteroid. */
export function generateDemo(ra: number, dec: number, n: number, scaleDeg: number): ExpRecord[] {
  const rand = mulberry32(Math.round(ra * 1000) * 7919 + Math.round((dec + 90) * 1000));
  const gauss = () => { const u = Math.max(1e-9, rand()), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const c = (n - 1) / 2;
  const omega = (scaleDeg * Math.PI / 180) ** 2;
  const mJyToSum = 1 / (omega * 1e9); // mJy -> sum of MJy/sr over pixels
  const srcs: Src[] = [];
  const nStars = Math.round((n * n) / 40);
  for (let i = 0; i < nStars; i++) {
    const f0 = Math.exp(Math.log(0.04) + rand() * Math.log(25 / 0.04));
    const alpha = 0.6 + rand() * 1.6;
    srcs.push({ x: rand() * n - 0.5, y: rand() * n - 0.5, vx: 0, vy: 0, sed: (wl: number) => f0 * Math.pow(wl / 1.6, -alpha) });
  }
  const day = (pxPerEpoch: number) => pxPerEpoch / 184;
  // cold Y dwarf: almost invisible < 3 um, bright at 4.6 um; moves through the reticle
  srcs.push({ x: c, y: c, vx: day(-1.9), vy: day(0.7), sed: (wl: number) => 0.015 + 3.2 * Math.exp(-(((wl - 4.65) / 0.33) ** 2)) + 0.35 * Math.exp(-(((wl - 4.0) / 0.22) ** 2)) + 0.05 * Math.exp(-(((wl - 1.27) / 0.08) ** 2)) });
  // Barnard-like high proper-motion red dwarf
  srcs.push({ x: c + 0.24 * n, y: c - 0.2 * n, vx: day(-1.1), vy: day(1.5), sed: (wl: number) => 45 * Math.pow(wl / 1.2, -1.5) * (1 - 0.25 * Math.exp(-(((wl - 2.7) / 0.25) ** 2))) });
  // Mira-type long-period variable (P ~ 330 d)
  srcs.push({ x: c - 0.26 * n, y: c + 0.21 * n, vx: 0, vy: 0, sed: (wl: number) => 22 * Math.exp(-(((wl - 1.9) / 1.4) ** 2)) + 3, vary: (mjd: number) => 1 + 0.72 * Math.sin((2 * Math.PI * (mjd - 60810)) / 330) });
  // asteroid visible only during epoch 2, racing across the field
  const e2 = DEMO_EPOCHS[1] ?? 60985.7;
  srcs.push({ x: c + 0.05 * n, y: c - 0.3 * n, vx: 0.35, vy: 0.15, window: [e2 - 1, e2 + 3], sed: (wl: number) => 2.2 * Math.pow(wl / 1.0, -1.1) + (wl > 3.2 ? 1.8 * ((wl - 3.2) / 1.8) ** 2 : 0) });

  const out: ExpRecord[] = [];
  const PER = 3;
  DEMO_EPOCHS.forEach((em: number, e: number) => {
    for (let b = 1; b <= 6; b++) {
      const [lo, hi] = BANDS[b] ?? [1, 2];
      for (let k = 0; k < PER; k++) {
        const mjd = em + k * 0.6 + b * 0.013;
        const frac = (((k + 0.5) / PER + e * 0.083) % 1);
        const wl = lo + frac * (hi - lo);
        const sig = 0.7 + 0.07 * b;
        const noise = 0.012 + 0.006 * b;
        const data = new Float32Array(n * n);
        const grad = (rand() - 0.5) * 0.004;
        for (let i = 0; i < n * n; i++) data[i] = noise * gauss() + grad * ((i % n) - c);
        for (const s of srcs) {
          if (s.window && (mjd < s.window[0] || mjd > s.window[1])) continue;
          const dt = s.window ? mjd - s.window[0] : mjd - T_REF;
          const sx = s.x + s.vx * dt, sy = s.y + s.vy * dt;
          const tot = s.sed(wl) * (s.vary?.(mjd) ?? 1) * mJyToSum;
          const r = Math.ceil(sig * 4);
          const x0 = Math.max(0, Math.floor(sx - r)), x1 = Math.min(n - 1, Math.ceil(sx + r));
          const y0 = Math.max(0, Math.floor(sy - r)), y1 = Math.min(n - 1, Math.ceil(sy + r));
          const norm = tot / (2 * Math.PI * sig * sig);
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[y * n + x] += norm * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * sig * sig));
        }
        let bad = 0;
        const nb = Math.floor(n * n * 0.003 * rand());
        for (let j = 0; j < nb; j++) { data[Math.floor(rand() * n * n)] = NaN; bad++; }
        out.push({ band: b, mjd, wl, flagFrac: bad / (n * n), flags: bad ? ['HOT', 'OUTLIER'] : [], data });
      }
    }
  });
  return out;
}
