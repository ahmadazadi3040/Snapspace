'use client';
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, Legend, LineChart, Line,
} from 'recharts';
import type { SpecPoint, LcPoint } from '@/lib/spherex/shared';

export const EPOCH_COLORS = ['#60B5FF', '#FF9149', '#80D8C3', '#FF90BB', '#A19AD3', '#72BF78', '#FF6363', '#FF9898'];
export const BAND_COLORS = ['#7aa2ff', '#60B5FF', '#80D8C3', '#72BF78', '#FF9149', '#FF6363'];

const tooltipStyle = { fontSize: 11, background: '#0b1220', border: '1px solid #1f2a3d', borderRadius: 6, color: '#e2e8f0' };

export function SpectrumChart({ points, epochLabels }: { points: SpecPoint[]; epochLabels: string[] }) {
  const byEpoch = new Map<number, SpecPoint[]>();
  (points ?? []).forEach((p: SpecPoint) => {
    const arr = byEpoch.get(p?.epoch ?? 0) ?? [];
    arr.push(p);
    byEpoch.set(p?.epoch ?? 0, arr);
  });
  const epochs = [...byEpoch.keys()].sort((a: number, b: number) => a - b);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 8, right: 16, bottom: 28, left: 18 }}>
        <XAxis
          type="number" dataKey="wavelength" name="Wavelength (µm)" domain={[0.7, 5.05]}
          tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#334155"
          ticks={[1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]}
          label={{ value: 'Wavelength (µm)', position: 'insideBottom', offset: -15, style: { textAnchor: 'middle', fontSize: 11, fill: '#94a3b8' } }}
        />
        <YAxis
          type="number" dataKey="flux" name="Flux (mJy)" width={58}
          tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#334155"
          tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(2))}
          label={{ value: 'Flux (mJy)', angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fontSize: 11, fill: '#94a3b8' } }}
        />
        <ZAxis range={[22, 22]} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: '#334155' }} />
        <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
        {epochs.map((e: number) => (
          <Scatter
            key={e} name={epochLabels?.[e] ?? `Epoch ${e + 1}`} data={byEpoch.get(e) ?? []}
            fill={EPOCH_COLORS[e % EPOCH_COLORS.length]} isAnimationActive
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

export function LightCurveChart({ points }: { points: LcPoint[] }) {
  const bands = [1, 2, 3, 4, 5, 6].filter((b: number) => (points ?? []).some((p: LcPoint) => typeof p?.[`D${b}`] === 'number'));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points ?? []} margin={{ top: 8, right: 16, bottom: 28, left: 18 }}>
        <XAxis
          dataKey="utc" tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#334155" interval="preserveStartEnd"
          label={{ value: 'Epoch date (UTC)', position: 'insideBottom', offset: -15, style: { textAnchor: 'middle', fontSize: 11, fill: '#94a3b8' } }}
        />
        <YAxis
          width={58} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#334155"
          tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(2))}
          label={{ value: 'Flux (mJy)', angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fontSize: 11, fill: '#94a3b8' } }}
        />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
        {bands.map((b: number) => (
          <Line
            key={b} type="monotone" dataKey={`D${b}`} name={`D${b}`} stroke={BAND_COLORS[b - 1]} strokeWidth={2}
            dot={{ r: 3 }} connectNulls isAnimationActive
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
