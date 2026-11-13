import { parseFits, type Hdu } from './core';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const SCS = 'https://irsa.ipac.caltech.edu/SCS';

export interface SiaRow { obsId: string; band: number; mjd: number; url: string; exptime: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url: string, timeoutMs: number, tries = 3): Promise<Response> {
  let last: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
    await sleep(600 * (i + 1) + Math.random() * 400);
  }
  throw last ?? new Error('fetch failed');
}

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** SIA2 query of the spherex_dr1 collection for images containing (ra, dec). */
export async function querySia(ra: number, dec: number): Promise<SiaRow[]> {
  const url = `${SIA}?COLLECTION=spherex_dr1&POS=CIRCLE+${ra}+${dec}+0.002&RESPONSEFORMAT=VOTABLE`;
  const xml = await (await fetchRetry(url, 20000)).text();
  const fields = [...xml.matchAll(/<FIELD [^>]*name="([^"]*)"/g)].map((m: RegExpMatchArray) => m[1] ?? '');
  const idx = (n: string) => fields.indexOf(n);
  const iBand = idx('energy_bandpassname'), iUrl = idx('access_url'), iT = idx('t_min'), iT2 = idx('t_max'), iObs = idx('obs_id'), iSub = idx('dataproduct_subtype'), iExp = idx('t_exptime');
  if (iBand < 0 || iUrl < 0 || iT < 0) throw new Error('Unexpected SIA2 response');
  const rows: SiaRow[] = [];
  for (const m of xml.matchAll(/<TR>([\s\S]*?)<\/TR>/g)) {
    const cells = [...(m[1] ?? '').matchAll(/<TD>([\s\S]*?)<\/TD>|<TD\/>/g)].map((c: RegExpMatchArray) => decodeXml(c[1] ?? ''));
    const sub = iSub >= 0 ? cells[iSub] : 'science';
    if (sub && sub !== 'science') continue;
    const band = parseInt((cells[iBand] ?? '').replace(/\D/g, '').slice(-1), 10);
    const t1 = parseFloat(cells[iT] ?? ''), t2 = parseFloat(cells[iT2] ?? '');
    const u = cells[iUrl] ?? '';
    if (!(band >= 1 && band <= 6) || !Number.isFinite(t1) || !u.startsWith('http')) continue;
    rows.push({ obsId: cells[iObs] ?? u, band, mjd: Number.isFinite(t2) ? (t1 + t2) / 2 : t1, url: u, exptime: parseFloat(cells[iExp] ?? '0') || 0 });
  }
  return rows;
}

/**
 * Download a cutout, streaming only until IMAGE, FLAGS, VARIANCE and ZODI are complete –
 * the large EPSF table at the end of the file is never transferred.
 */
export async function fetchCutout(url: string, ra: number, dec: number, sizeDeg: number): Promise<Record<string, Hdu>> {
  const full = `${url}?center=${ra.toFixed(6)},${dec.toFixed(6)}&size=${sizeDeg.toFixed(5)}`;
  const res = await fetchRetry(full, 30000, 4);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const chunks: Buffer[] = [];
  let total = 0, lastParse = 0;
  let hdus: Hdu[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (value) { chunks.push(Buffer.from(value)); total += value.length; }
    if (done || total - lastParse > 16384) {
      lastParse = total;
      hdus = parseFits(Buffer.concat(chunks));
      const names = hdus.map((h: Hdu) => h.name);
      if (['IMAGE', 'FLAGS', 'ZODI'].every((n: string) => names.includes(n))) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    }
    if (done) break;
  }
  const out: Record<string, Hdu> = {};
  for (const h of hdus) out[h.name] = h;
  if (!out.IMAGE?.data) throw new Error('cutout missing IMAGE');
  return out;
}

/** Bounded-concurrency map. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i] as T, i); } catch (e) { console.warn('pool item failed', (e as Error)?.message ?? e); out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.length > 1 || row[0]) rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export interface RawStar { ra: number; dec: number; mag: number | null; pmra: number | null; pmdec: number | null; id: string }

/** IRSA simple cone search (Gaia DR3 / AllWISE). */
export async function coneSearch(src: 'gaia' | 'allwise', ra: number, dec: number, radiusDeg: number): Promise<RawStar[]> {
  const table = src === 'gaia' ? 'gaia_dr3_source' : 'allwise_p3as_psd';
  const res = await fetchRetry(`${SCS}?table=${table}&RA=${ra}&DEC=${dec}&SR=${radiusDeg.toFixed(5)}&format=csv`, 25000, 2);
  const rows = parseCsv(await res.text());
  const head = rows[0] ?? [];
  const col = (n: string) => head.indexOf(n);
  const iRa = col('ra'), iDec = col('dec');
  const iMag = col(src === 'gaia' ? 'phot_g_mean_mag' : 'w1mpro');
  const iPmra = col('pmra'), iPmdec = col('pmdec'), iId = col(src === 'gaia' ? 'designation' : 'designation');
  if (iRa < 0 || iDec < 0) return [];
  const num = (v: string | undefined) => { const x = parseFloat(v ?? ''); return Number.isFinite(x) ? x : null; };
  return rows.slice(1).map((r: string[]) => ({
    ra: num(r[iRa]) ?? NaN, dec: num(r[iDec]) ?? NaN, mag: iMag >= 0 ? num(r[iMag]) : null,
    pmra: src === 'gaia' && iPmra >= 0 ? num(r[iPmra]) : null, pmdec: src === 'gaia' && iPmdec >= 0 ? num(r[iPmdec]) : null,
    id: iId >= 0 ? (r[iId] ?? '') : '',
  })).filter((s: RawStar) => Number.isFinite(s.ra) && Number.isFinite(s.dec));
}
