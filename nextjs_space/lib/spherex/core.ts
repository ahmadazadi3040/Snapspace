import zlib from 'zlib';

// ---------- FITS ----------
export type Header = Record<string, string | number | boolean>;
export interface Hdu { header: Header; name: string; w: number; h: number; data: Float32Array | null; idata: Int32Array | null; end: number }

function parseCard(card: string): [string, string | number | boolean] | null {
  const key = card.slice(0, 8).trim();
  if (!key || card[8] !== '=') return key ? [key, ''] : null;
  let v = card.slice(10).trim();
  if (v.startsWith("'")) { const e = v.indexOf("'", 1); return [key, v.slice(1, e > 0 ? e : undefined).trim()]; }
  v = v.split('/')[0].trim();
  if (v === 'T') return [key, true];
  if (v === 'F') return [key, false];
  const n = Number(v);
  return [key, Number.isNaN(n) ? v : n];
}

/** Parse as many complete HDUs as present in buf. */
export function parseFits(buf: Buffer): Hdu[] {
  const out: Hdu[] = [];
  let off = 0;
  while (off + 2880 <= buf.length) {
    const header: Header = {};
    let done = false;
    while (off + 2880 <= buf.length && !done) {
      for (let i = 0; i < 36; i++) {
        const card = buf.toString('latin1', off + i * 80, off + i * 80 + 80);
        if (card.startsWith('END') && card.slice(3).trim() === '') { done = true; break; }
        const kv = parseCard(card);
        if (kv && kv[0] !== 'COMMENT' && kv[0] !== 'HISTORY') header[kv[0]] = kv[1];
      }
      off += 2880;
    }
    if (!done) break;
    const bitpix = Number(header.BITPIX ?? 8), naxis = Number(header.NAXIS ?? 0);
    let n = naxis > 0 ? 1 : 0;
    for (let i = 1; i <= naxis; i++) n *= Number(header['NAXIS' + i] ?? 0);
    const bytes = (Math.abs(bitpix) / 8) * (n + Number(header.PCOUNT ?? 0));
    const padded = Math.ceil(bytes / 2880) * 2880;
    if (off + bytes > buf.length) break;
    const w = Number(header.NAXIS1 ?? 0), h = Number(header.NAXIS2 ?? 0);
    let data: Float32Array | null = null;
    let idata: Int32Array | null = null;
    if (naxis === 2 && header.XTENSION !== 'BINTABLE') {
      data = new Float32Array(n);
      const bz = Number(header.BZERO ?? 0), bs = Number(header.BSCALE ?? 1);
      if (bitpix === 32 && bz === 0 && bs === 1) { idata = new Int32Array(n); for (let i = 0; i < n; i++) idata[i] = buf.readInt32BE(off + i * 4); }
      for (let i = 0; i < n; i++) {
        const p = off + i * (Math.abs(bitpix) / 8);
        let v = 0;
        if (bitpix === -32) v = buf.readFloatBE(p);
        else if (bitpix === -64) v = buf.readDoubleBE(p);
        else if (bitpix === 32) v = buf.readInt32BE(p);
        else if (bitpix === 16) v = buf.readInt16BE(p);
        else v = buf.readUInt8(p);
        data[i] = v * bs + bz;
      }
    }
    out.push({ header, name: String(header.EXTNAME ?? (out.length === 0 ? 'PRIMARY' : '')), w, h, data, idata, end: off + padded });
    off += padded;
  }
  return out;
}

function card(k: string, v: string | number | boolean): string {
  let s = typeof v === 'string' ? `'${v.padEnd(8)}'` : typeof v === 'boolean' ? (v ? 'T' : 'F') : String(v);
  if (typeof v !== 'string') s = s.padStart(20);
  return (k.padEnd(8) + '= ' + s).padEnd(80).slice(0, 80);
}
function headerBlock(h: Header): Buffer {
  let s = Object.entries(h).map(([k, v]) => card(k, v)).join('') + 'END'.padEnd(80);
  s = s.padEnd(Math.ceil(s.length / 2880) * 2880);
  return Buffer.from(s, 'latin1');
}
export function writeFits(hdus: { header: Header; data: Float32Array | Int32Array; w: number; h: number }[]): Buffer {
  const parts: Buffer[] = [headerBlock({ SIMPLE: true, BITPIX: 8, NAXIS: 0, EXTEND: true })];
  for (const hd of hdus) {
    const isInt = hd.data instanceof Int32Array;
    parts.push(headerBlock({ XTENSION: 'IMAGE', BITPIX: isInt ? 32 : -32, NAXIS: 2, NAXIS1: hd.w, NAXIS2: hd.h, PCOUNT: 0, GCOUNT: 1, ...hd.header }));
    const b = Buffer.alloc(Math.ceil((hd.data.length * 4) / 2880) * 2880);
    for (let i = 0; i < hd.data.length; i++) isInt ? b.writeInt32BE(hd.data[i], i * 4) : b.writeFloatBE(hd.data[i], i * 4);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// ---------- TAN-SIP WCS ----------
const D2R = Math.PI / 180;
export class TanSip {
  crval: [number, number]; crpix: [number, number]; cd: number[]; cdi: number[];
  A: Map<string, number>; B: Map<string, number>; AP: Map<string, number>; BP: Map<string, number>;
  constructor(h: Header) {
    const g = (k: string, d = 0) => Number(h[k] ?? d);
    this.crval = [g('CRVAL1'), g('CRVAL2')];
    this.crpix = [g('CRPIX1'), g('CRPIX2')];
    if (h.CD1_1 !== undefined) this.cd = [g('CD1_1'), g('CD1_2'), g('CD2_1'), g('CD2_2')];
    else { const c1 = g('CDELT1', 1), c2 = g('CDELT2', 1); this.cd = [c1 * g('PC1_1', 1), c1 * g('PC1_2'), c2 * g('PC2_1'), c2 * g('PC2_2', 1)]; }
    const det = this.cd[0] * this.cd[3] - this.cd[1] * this.cd[2];
    this.cdi = [this.cd[3] / det, -this.cd[1] / det, -this.cd[2] / det, this.cd[0] / det];
    const coeffs = (p: string) => { const m = new Map<string, number>(); for (const k of Object.keys(h)) { const r = k.match(new RegExp(`^${p}_(\\d+)_(\\d+)$`)); if (r) m.set(`${r[1]}_${r[2]}`, Number(h[k])); } return m; };
    this.A = coeffs('A'); this.B = coeffs('B'); this.AP = coeffs('AP'); this.BP = coeffs('BP');
  }
  private poly(m: Map<string, number>, u: number, v: number): number {
    let s = 0; m.forEach((c: number, k: string) => { const [p, q] = k.split('_').map(Number); s += c * u ** p * v ** q; }); return s;
  }
  /** world (deg) -> 0-based array pixel coords */
  world2pix(ra: number, dec: number): [number, number] {
    const a = ra * D2R, d = dec * D2R, a0 = this.crval[0] * D2R, d0 = this.crval[1] * D2R;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    const x = (Math.cos(d) * Math.sin(a - a0)) / cosc / D2R;
    const y = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc / D2R;
    const U = this.cdi[0] * x + this.cdi[1] * y, V = this.cdi[2] * x + this.cdi[3] * y;
    let u = U + this.poly(this.AP, U, V), v = V + this.poly(this.BP, U, V);
    if (this.A.size) for (let i = 0; i < 6; i++) { const nu = U - this.poly(this.A, u, v), nv = V - this.poly(this.B, u, v); u = nu; v = nv; }
    return [u + this.crpix[0] - 1, v + this.crpix[1] - 1];
  }
}

/** Least-squares affine out(px,py) -> in(x,y), the scipy.ndimage.affine_transform matrix. */
export function fitAffine(pairs: [number, number, number, number][]): number[] {
  const solve = (idx: 2 | 3) => {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
    for (const p of pairs) { const v = [p[0], p[1], 1]; for (let i = 0; i < 3; i++) { r[i] += v[i] * p[idx]; for (let j = 0; j < 3; j++) M[i][j] += v[i] * v[j]; } }
    const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det3(M);
    return [0, 1, 2].map((c: number) => det3(M.map((row: number[], i: number) => row.map((x: number, j: number) => (j === c ? r[i] : x)))) / D);
  };
  return [...solve(2), ...solve(3)];
}

export function affineResample(src: Float32Array, w: number, h: number, A: number[], n: number, nearest = false): Float32Array {
  const out = new Float32Array(n * n).fill(NaN);
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
    const x = A[0] * px + A[1] * py + A[2], y = A[3] * px + A[4] * py + A[5];
    if (nearest) { const ix = Math.round(x), iy = Math.round(y); if (ix >= 0 && iy >= 0 && ix < w && iy < h) out[py * n + px] = src[iy * w + ix]; continue; }
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
    const i = y0 * w + x0;
    out[py * n + px] = src[i] * (1 - fx) * (1 - fy) + src[i + 1] * fx * (1 - fy) + src[i + w] * (1 - fx) * fy + src[i + w + 1] * fx * fy;
  }
  return out;
}

// ---------- statistics & stretch ----------
export function percentiles(arrs: Float32Array[], ps: number[]): number[] {
  const vals: number[] = [];
  for (const a of arrs) for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) vals.push(a[i]);
  if (!vals.length) return ps.map(() => 0);
  vals.sort((x: number, y: number) => x - y);
  return ps.map((p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))))]);
}
export const median = (a: Float32Array) => percentiles([a], [50])[0];
/** astropy AsinhStretch(a=0.1) after percentile interval clip */
export const asinhStretch = (v: number, lo: number, hi: number, a = 0.1) => {
  const x = Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1)));
  return Math.asinh(x / a) / Math.asinh(1 / a);
};

// ---------- PNG ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Buffer): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
/** rgb: n*n*3 bytes; upscaled with nearest-neighbour for crisp pixels; tEXt metadata embedded. */
export function encodePng(rgb: Uint8Array, n: number, meta: Record<string, string>): Buffer {
  const f = Math.max(1, Math.ceil(512 / n)), W = n * f;
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) {
    const row = y * (W * 3 + 1), sy = Math.floor(y / f);
    for (let x = 0; x < W; x++) { const s = (sy * n + Math.floor(x / f)) * 3, d = row + 1 + x * 3; raw[d] = rgb[s]; raw[d + 1] = rgb[s + 1]; raw[d + 2] = rgb[s + 2]; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  const texts = Object.entries(meta).map(([k, v]) => chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1')));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...texts, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
