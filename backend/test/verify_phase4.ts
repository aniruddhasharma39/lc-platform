import { prisma } from '../src/lib/prisma';
import { getExamCompliance } from '../src/routes/roster';

async function main() {
  console.log('========================================================================');
  console.log('🚀 RUNNING PHASE 4 USER HIERARCHY, SCOPE & COMPLIANCE VERIFICATION');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, msg: string) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${msg}`);
      process.exitCode = 1;
    }
  }

  // 1. Verify Role Seniority & Hierarchy in Database
  console.log('--- 1. Engineering Hierarchy Roles in Database ---');
  const roles = await prisma.role.findMany();
  const roleNames = roles.map(r => r.name);

  assert(roleNames.includes('CPWI'), 'Role CPWI exists in database');
  assert(roleNames.includes('PWI'), 'Role PWI exists in database');
  assert(roleNames.includes('Restkeeper'), 'Role Restkeeper exists in database');
  assert(roleNames.includes('Gateman'), 'Role Gateman exists in database');
  assert(roleNames.includes('ADEN'), 'Role ADEN exists in database');
  assert(roleNames.includes('DEN'), 'Role DEN exists in database');
  assert(roleNames.includes('Senior DEN'), 'Role Senior DEN exists in database');

  // 2. Verify PME and RC Fields & Expiry Calculation on Users
  console.log('\n--- 2. PME & RC Compliance Fields in Users Table ---');
  const userCount = await prisma.user.count();
  assert(userCount > 0, `Users table has ${userCount} active users`);

  // Create a temporary Gateman with PME and RC to verify API data shape
  const gatemanRole = await prisma.role.findFirst({ where: { name: 'Gateman' } });
  const testGateman = await prisma.user.create({
    data: {
      fullName: 'Verif Gateman Test',
      email: 'gateman.verif@rail.gov.in',
      mobile: '9900112233',
      employeeId: 'IR-GM-VERIF',
      department: 'Engineering',
      designation: 'Gateman',
      roleId: gatemanRole!.id,
      status: 'APPROVED',
      pmeDate: new Date('2024-05-10T00:00:00.000Z'),
      pmeExpiryDate: new Date('2028-05-10T00:00:00.000Z'),
      pmeCertificateNo: 'PME/VERIF/2024',
      rcDate: new Date('2025-01-20T00:00:00.000Z'),
      rcExpiryDate: new Date('2027-01-20T00:00:00.000Z'),
      rcInstitute: 'ZRTI STC',
      passwordHash: 'hash123',
    }
  });

  assert(testGateman.pmeExpiryDate !== null, 'pmeExpiryDate is present on user');
  assert(testGateman.rcExpiryDate !== null, 'rcExpiryDate is present on user');

  const pmeStatus = getExamCompliance(testGateman.pmeExpiryDate);
  const rcStatus = getExamCompliance(testGateman.rcExpiryDate);
  assert(pmeStatus === 'VALID', `Gateman PME compliance evaluates to VALID (2028)`);
  assert(rcStatus === 'VALID', `Gateman RC compliance evaluates to VALID (2027)`);

  // 3. Verify Multi-Gate Linking on Restkeeper
  console.log('\n--- 3. Restkeeper Multi-Gate Association ---');
  const restkeeperRole = await prisma.role.findFirst({ where: { name: 'Restkeeper' } });
  const station = await prisma.station.findFirst({ include: { gates: true } });
  const sampleGates = await prisma.lCGate.findMany({ take: 2 });

  const testRestkeeper = await prisma.user.create({
    data: {
      fullName: 'Verif Restkeeper Test',
      email: 'restkeeper.verif@rail.gov.in',
      mobile: '9900112244',
      employeeId: 'IR-RK-VERIF',
      department: 'Engineering',
      designation: 'Restkeeper',
      roleId: restkeeperRole!.id,
      stationId: station?.id,
      status: 'APPROVED',
      passwordHash: 'hash123',
    }
  });

  for (const g of sampleGates) {
    await prisma.userGate.create({
      data: { userId: testRestkeeper.id, gateId: g.id }
    });
  }

  const rkWithGates = await prisma.user.findUnique({
    where: { id: testRestkeeper.id },
    include: {
      assignedGates: {
        include: { gate: true }
      },
      station: true
    }
  });

  assert(rkWithGates?.assignedGates.length === sampleGates.length, `Restkeeper linked to multiple gates (${sampleGates.length} gates)`);
  assert(rkWithGates?.station?.id === station?.id, 'Restkeeper linked to station');

  // Clean up verification records
  await prisma.userGate.deleteMany({ where: { userId: testRestkeeper.id } });
  await prisma.user.delete({ where: { id: testRestkeeper.id } });
  await prisma.user.delete({ where: { id: testGateman.id } });
  console.log('  🧹 Cleaned up verification records');

  console.log('\n========================================================================');
  console.log(`🎉 PHASE 4 VERIFICATION COMPLETE: ${passed}/${total} TESTS PASSED!`);
  console.log('========================================================================\n');
}

main()
  .catch(e => {
    console.error('Phase 4 verification failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
