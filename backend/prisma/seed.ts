import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const roles = [
    'Developer',
    'Zone Officer',
    'Division Officer',
    'Section / Station Master',
    'Gatesman',
  ];

  console.log('Seeding roles...');
  for (const roleName of roles) {
    await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName },
    });
  }

  const devRole = await prisma.role.findUnique({ where: { name: 'Developer' } });
  
  if (!devRole) {
    throw new Error('Developer role not found after seed.');
  }

  const devEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@lcgate.in';
  const devPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
  const hashedPassword = await bcrypt.hash(devPassword, 10);

  console.log('Seeding default Developer user...');
  await prisma.user.upsert({
    where: { email: devEmail },
    update: {},
    create: {
      fullName: 'System Admin',
      email: devEmail,
      mobile: '0000000000',
      employeeId: 'DEV-001',
      department: 'IT',
      roleId: devRole.id,
      status: 'APPROVED',
      passwordHash: hashedPassword,
      mustChangePassword: true,
    },
  });

  console.log('Seed completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
