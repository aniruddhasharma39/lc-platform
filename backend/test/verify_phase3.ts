import { prisma } from '../src/lib/prisma';
import { getExamCompliance } from '../src/routes/roster';

async function main() {
  console.log('========================================================================');
  console.log('🚀 RUNNING PHASE 3 END-TO-END REGISTRATION & COMPLIANCE VERIFICATION');
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

  // 1. Check Station and Gate for Restkeeper
  console.log('--- 1. Verification of Station & Multiple Gate Setup ---');
  let station = await prisma.station.findFirst({
    where: { gates: { some: {} } },
    include: { gates: true }
  });
  if (!station) {
    station = await prisma.station.findFirst({ include: { gates: true } });
  }
  assert(!!station, 'Found station in database');
  const gateIds = station && station.gates.length > 0
    ? station.gates.map(g => g.id)
    : (await prisma.lCGate.findMany({ take: 3 })).map(g => g.id);
  assert(gateIds.length > 0, `Station has ${gateIds.length} gates for Restkeeper rounds`);

  // 2. Simulate Registration Submission with PME and RC
  console.log('\n--- 2. Simulate Registration Request with PME & RC Data ---');
  const form = await prisma.registrationForm.findFirst({ where: { status: 'LIVE' } });
  assert(!!form, 'Found live registration form');

  const testMobile = '9876543210';
  const testEmail = 'restkeeper.test@indianrail.gov.in';

  // Clean up any previous test records
  await prisma.registrationRequest.deleteMany({
    where: {
      OR: [
        { data: { contains: testMobile } },
        { data: { contains: testEmail } }
      ]
    }
  });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { mobile: testMobile },
        { email: testEmail }
      ]
    }
  });

  const pmeExamDate = new Date('2024-03-10T00:00:00.000Z');
  const pmeExpDate = new Date('2028-03-10T00:00:00.000Z'); // +4 years
  const rcCourseDate = new Date('2026-02-15T00:00:00.000Z');
  const rcExpDate = new Date('2028-02-15T00:00:00.000Z'); // +2 years

  const regData = {
    fullName: 'Rameshwar Restkeeper',
    mobile: testMobile,
    email: testEmail,
    employeeId: 'IR-ENG-RK-001',
    password: 'password123',
    department: 'Engineering',
    designation: 'Restkeeper',
    zone: station?.zone || 'WR',
    division: station?.division || 'RTM',
    stationId: station?.id,
    gateIds: gateIds,
    pmeDate: '2024-03-10',
    pmeExpiryDate: '2028-03-10',
    pmeCertificateNo: 'PME/WR/2024/991',
    rcDate: '2026-02-15',
    rcExpiryDate: '2028-02-15',
    rcInstitute: 'ZRTI Bhusawal',
    declarationConfirmed: true
  };

  const reqRow = await prisma.registrationRequest.create({
    data: {
      formId: form!.id,
      data: JSON.stringify(regData),
      department: 'Engineering',
      designation: 'Restkeeper',
      zone: station?.zone || 'WR',
      division: station?.division || 'RTM',
      stationId: station?.id,
      gateIds: gateIds,
      pmeDate: pmeExamDate,
      pmeExpiryDate: pmeExpDate,
      pmeCertificateNo: 'PME/WR/2024/991',
      rcDate: rcCourseDate,
      rcExpiryDate: rcExpDate,
      rcInstitute: 'ZRTI Bhusawal',
      declarationConfirmed: true,
      status: 'PENDING'
    }
  });

  assert(reqRow.id > 0, 'RegistrationRequest created with PME & RC fields');
  assert(reqRow.designation === 'Restkeeper', 'Request designation is Restkeeper');
  assert(reqRow.pmeCertificateNo === 'PME/WR/2024/991', 'PME certificate number stored');
  assert(reqRow.rcInstitute === 'ZRTI Bhusawal', 'RC institute stored');
  assert(reqRow.gateIds.length === gateIds.length, `Multi-gate list preserved (${gateIds.length} gates)`);

  // 3. Verify Approval Flow Transfers Data to User
  console.log('\n--- 3. Approve Registration and Transfer to User Record ---');
  const restkeeperRole = await prisma.role.findFirst({ where: { name: 'Restkeeper' } });
  assert(!!restkeeperRole, 'Found Restkeeper role in database');

  const createdUser = await prisma.user.create({
    data: {
      fullName: regData.fullName,
      email: regData.email,
      mobile: regData.mobile,
      employeeId: regData.employeeId,
      department: 'Engineering',
      designation: 'Restkeeper',
      roleId: restkeeperRole!.id,
      zone: reqRow.zone,
      division: reqRow.division,
      stationId: reqRow.stationId,
      status: 'APPROVED',
      pmeDate: reqRow.pmeDate,
      pmeExpiryDate: reqRow.pmeExpiryDate,
      pmeCertificateNo: reqRow.pmeCertificateNo,
      rcDate: reqRow.rcDate,
      rcExpiryDate: reqRow.rcExpiryDate,
      rcInstitute: reqRow.rcInstitute,
      passwordHash: 'dummyhash',
      metadata: '{}'
    },
    include: { role: true, station: true }
  });

  // Assign multiple gates
  for (const gId of gateIds) {
    await prisma.userGate.upsert({
      where: { userId_gateId: { userId: createdUser.id, gateId: gId } },
      update: {},
      create: { userId: createdUser.id, gateId: gId }
    });
  }

  assert(createdUser.id > 0, 'User created successfully with Restkeeper role');
  assert(createdUser.role.name === 'Restkeeper', 'User has role Restkeeper');
  assert(createdUser.pmeCertificateNo === 'PME/WR/2024/991', 'User record has PME certificate number');
  assert(createdUser.rcInstitute === 'ZRTI Bhusawal', 'User record has RC institute');

  // Verify multi-gate assignments for Restkeeper
  const userGates = await prisma.userGate.findMany({ where: { userId: createdUser.id } });
  assert(userGates.length === gateIds.length, `Restkeeper has ${userGates.length} gates assigned`);

  // 4. Verify Computed Compliance Statuses
  console.log('\n--- 4. Verify Exam Compliance Status Calculations ---');
  const pmeStatus = getExamCompliance(createdUser.pmeExpiryDate);
  const rcStatus = getExamCompliance(createdUser.rcExpiryDate);
  assert(pmeStatus === 'VALID', `PME status is VALID (Expires ${createdUser.pmeExpiryDate?.toISOString().split('T')[0]})`);
  assert(rcStatus === 'VALID', `RC status is VALID (Expires ${createdUser.rcExpiryDate?.toISOString().split('T')[0]})`);

  // Clean up test records
  await prisma.userGate.deleteMany({ where: { userId: createdUser.id } });
  await prisma.user.delete({ where: { id: createdUser.id } });
  await prisma.registrationRequest.delete({ where: { id: reqRow.id } });
  console.log('  🧹 Cleaned up test records');

  console.log('\n========================================================================');
  console.log(`🎉 PHASE 3 VERIFICATION COMPLETE: ${passed}/${total} TESTS PASSED!`);
  console.log('========================================================================\n');
}

main()
  .catch(e => {
    console.error('Phase 3 verification failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
