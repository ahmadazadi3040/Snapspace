import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await prisma.searchLog.findMany({
      orderBy: { updatedAt: 'desc' }, take: 8,
      select: { id: true, ra: true, dec: true, fov: true, dataMode: true, epochCount: true, exposureCount: true, hits: true },
    });
    return NextResponse.json({ recent: rows });
  } catch (e) {
    console.warn('recent failed', (e as Error)?.message);
    return NextResponse.json({ recent: [] });
  }
}
