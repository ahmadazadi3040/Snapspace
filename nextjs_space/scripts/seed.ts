import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = 'abacus-08b8afd6@example.com';
  const password = await bcrypt.hash('Z@l951upNO', 10);
  await prisma.user.upsert({
    where: { email },
    update: { password, role: 'admin' },
    create: { email, password, name: 'Admin', role: 'admin' },
  });
  console.log('seeded');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
