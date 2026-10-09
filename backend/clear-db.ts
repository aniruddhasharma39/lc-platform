import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  await prisma.$executeRawUnsafe('DELETE FROM "InstallationEvidence";');
  await prisma.$executeRawUnsafe('DELETE FROM "ChildDevice";');
  await prisma.$executeRawUnsafe('DELETE FROM "MasterUnit";');
  await prisma.$executeRawUnsafe('DELETE FROM "LCGate";');
}
main();
