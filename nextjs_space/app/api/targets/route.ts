import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const targets = await prisma.savedTarget.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  return NextResponse.json({ targets });
}

export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ra = Number(b?.ra), dec = Number(b?.dec), fov = Number(b?.fov ?? 5);
  const name = String(b?.name ?? '').trim().slice(0, 80);
  if (!name || !Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || Math.abs(dec) > 90) {
    return NextResponse.json({ error: 'Name and valid coordinates are required' }, { status: 400 });
  }
  const t = await prisma.savedTarget.create({ data: { userId, name, ra, dec, fov: [2, 5, 10].includes(fov) ? fov : 5, note: b?.note ? String(b.note).slice(0, 200) : null } });
  return NextResponse.json({ target: t }, { status: 201 });
}

export async function DELETE(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('id') ?? '';
  const t = await prisma.savedTarget.findFirst({ where: { id, userId } });
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.savedTarget.delete({ where: { id: t.id } });
  return NextResponse.json({ ok: true });
}
