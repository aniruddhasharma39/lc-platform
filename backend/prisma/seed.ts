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

  const modules = [
    { name: 'Manage Users', slug: 'manage-users' },
    { name: 'Roles', slug: 'roles' },
    { name: 'Registration Builder', slug: 'registration' },
    { name: 'Branding', slug: 'branding' },
    { name: 'Cluster', slug: 'cluster' },
    { name: 'Scope Groups', slug: 'scope-groups' },
  ];

  console.log('Seeding modules...');
  for (const mod of modules) {
    await prisma.module.upsert({
      where: { slug: mod.slug },
      update: {},
      create: { name: mod.name, slug: mod.slug },
    });
  }

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

  const devEmail = process.env.DEFAULT_ADMIN_EMAIL;
  const devPassword = process.env.DEFAULT_ADMIN_PASSWORD;

  if (!devEmail || !devPassword) {
    console.warn('Skipping Developer user seed: DEFAULT_ADMIN_EMAIL or DEFAULT_ADMIN_PASSWORD not set in environment.');
    return;
  }

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

  const existingForm = await prisma.registrationForm.findFirst({
    where: { status: 'LIVE' }
  });

  if (!existingForm) {
    console.log('Seeding default LIVE registration form...');
    const defaultSchema = {
      fields: [
        { id: '1', type: 'text', name: 'fullName', label: 'Full Name', required: true, placeholder: 'Enter your full name' },
        { id: '2', type: 'phone', name: 'mobile', label: 'Mobile Number', required: true, placeholder: '10-digit mobile number' },
        { id: '3', type: 'email', name: 'email', label: 'Email Address', required: true, placeholder: 'name@example.com' },
        { id: '4', type: 'text', name: 'employeeId', label: 'Employee ID', required: true, placeholder: 'e.g. EMP-101' },
        { id: '5', type: 'text', name: 'department', label: 'Department', required: true, placeholder: 'e.g. Engineering' },
        { id: '6', type: 'password', name: 'password', label: 'Password', required: true, placeholder: 'Create a password' }
      ],
      allowRoles: true
    };

    await prisma.registrationForm.create({
      data: {
        name: 'Standard Registration Form',
        schema: JSON.stringify(defaultSchema),
        status: 'LIVE',
        version: 1
      }
    });
  }

  const { ensureStationsPopulated } = require('./seedStations');
  await ensureStationsPopulated();
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
