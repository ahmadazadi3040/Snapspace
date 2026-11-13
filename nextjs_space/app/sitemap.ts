import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const base = host ? `https://${host}` : (process.env.NEXTAUTH_URL ?? 'http://localhost:3000');
  return ['', '/login', '/signup'].map((p: string) => ({ url: `${base}${p}`, changeFrequency: 'weekly' as const, priority: p ? 0.4 : 1 }));
}
