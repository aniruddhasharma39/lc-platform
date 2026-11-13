import { prisma } from '../src/lib/prisma';
import { getExamCompliance } from '../src/routes/roster';
import { DEFAULT_3_SHIFT_CONFIG, DEFAULT_2_SHIFT_CONFIG } from '../src/routes/shifts';

async function main() {
  console.log('========================================================================');
  console.log('🚀 RUNNING PHASE 5 ROSTER & DYNAMIC SHIFTS END-TO-END VERIFICATION');
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

  // 1. Dynamic Shift Configuration
  console.log('--- 1. Dynamic Shift Configuration (Custom Count & Timings) ---');
  const station = await prisma.station.findFirst({
    where: { gates: { some: {} } },
    include: { gates: true }
  });
  assert(!!station, 'Found station in database');

  const custom4Shifts = [
    { id: 's1', name: 'Early Morning', startTime: '04:00', endTime: '10:00' },
    { id: 's2', name: 'Day Duty', startTime: '10:00', endTime: '16:00' },
    { id: 's3', name: 'Evening Duty', startTime: '16:00', endTime: '22:00' },
    { id: 's4', name: 'Night Watch', startTime: '22:00', endTime: '04:00' },
  ];

  const shiftConfig = await prisma.gateShiftConfig.create({
    data: {
      name: 'Custom 4-Shift Pattern (6hr each)',
      stationId: station!.id,
      shiftsJson: JSON.stringify(custom4Shifts),
    }
  });

  assert(shiftConfig.id > 0, 'Created custom 4-shift schedule in GateShiftConfig');
  const parsedShifts = JSON.parse(shiftConfig.shiftsJson);
  assert(parsedShifts.length === 4, 'Shift count is dynamically configured to 4 shifts');
  assert(parsedShifts[0].startTime === '04:00' && parsedShifts[0].endTime === '10:00', 'Shift 1 custom timings preserved (04:00 - 10:00)');
  assert(parsedShifts[3].startTime === '22:00' && parsedShifts[3].endTime === '04:00', 'Shift 4 overnight timings preserved (22:00 - 04:00)');

  // 2. Fetch Gates and Eligible Gatemen under Station
  console.log('\n--- 2. Station Gates & Eligible Gatemen ---');
  const gates = await prisma.lCGate.findMany({
    where: { stationId: station!.id },
    take: 2
  });
  const gateIds = gates.map(g => g.id);
  assert(gateIds.length > 0, `Found ${gateIds.length} LC gate(s) for roster assignment`);

  const gatemanRole = await prisma.role.findFirst({ where: { name: 'Gateman' } });
  const gatemen = await prisma.user.findMany({
    where: {
      status: 'APPROVED',
      OR: [
        { roleId: gatemanRole?.id },
        { designation: { contains: 'Gateman', mode: 'insensitive' } }
      ]
    },
    take: 4
  });
  assert(gatemen.length > 0, `Found ${gatemen.length} active Gatemen in database`);

  // Verify compliance calculation for Gatemen
  for (const gm of gatemen) {
    const pmeStat = getExamCompliance(gm.pmeExpiryDate);
    const rcStat = getExamCompliance(gm.rcExpiryDate);
    assert(pmeStat !== undefined && rcStat !== undefined, `Gateman ${gm.fullName} has valid status tags (PME: ${pmeStat}, RC: ${rcStat})`);
  }

  // 3. Publish Duty Roster for Multiple Gates and Dynamic Shifts
  console.log('\n--- 3. Publish Daily Duty Roster ---');
  const testDate = '2026-11-25';
  const targetGate = gates[0];
  const assignedGateman = gatemen[0];
  const creatorUser = await prisma.user.findFirst({ where: { status: 'APPROVED' } });

  // Clean up any existing roster for test gate and date
  await prisma.gateDutyRoster.deleteMany({
    where: { gateId: targetGate.id, date: testDate }
  });

  const createdRoster1 = await prisma.gateDutyRoster.create({
    data: {
      gateId: targetGate.id,
      stationId: station!.id,
      date: testDate,
      shiftName: custom4Shifts[0].name,
      startTime: custom4Shifts[0].startTime,
      endTime: custom4Shifts[0].endTime,
      gatemanUserId: assignedGateman.id,
      createdById: creatorUser!.id,
    }
  });

  const createdRoster2 = await prisma.gateDutyRoster.create({
    data: {
      gateId: targetGate.id,
      stationId: station!.id,
      date: testDate,
      shiftName: custom4Shifts[1].name,
      startTime: custom4Shifts[1].startTime,
      endTime: custom4Shifts[1].endTime,
      gatemanUserId: gatemen.length > 1 ? gatemen[1].id : assignedGateman.id,
      createdById: creatorUser!.id,
    }
  });

  assert(createdRoster1.id > 0, `Roster slot 1 published: ${custom4Shifts[0].name} (${custom4Shifts[0].startTime} - ${custom4Shifts[0].endTime})`);
  assert(createdRoster2.id > 0, `Roster slot 2 published: ${custom4Shifts[1].name} (${custom4Shifts[1].startTime} - ${custom4Shifts[1].endTime})`);

  // 4. Gateman Personal Duty Shifts Retrieval (My Shifts)
  console.log('\n--- 4. Gateman Personal Shifts Retrieval (My Shifts) ---');
  const myShifts = await prisma.gateDutyRoster.findMany({
    where: {
      gatemanUserId: assignedGateman.id,
      date: { gte: '2026-11-01' }
    },
    include: {
      gate: true,
      station: true,
      createdBy: true,
    }
  });

  assert(myShifts.length > 0, `Gateman ${assignedGateman.fullName} has ${myShifts.length} upcoming scheduled duty shift(s)`);
  const firstShift = myShifts[0];
  assert(firstShift.gate.id === targetGate.id, `Shift matches assigned gate LC-${firstShift.gate.lcNumber}`);
  assert(firstShift.date === testDate, `Duty date matches published date ${testDate}`);

  // Clean up test records
  await prisma.gateDutyRoster.deleteMany({
    where: { gateId: targetGate.id, date: testDate }
  });
  await prisma.gateShiftConfig.delete({ where: { id: shiftConfig.id } });
  console.log('  🧹 Cleaned up test roster and shift configuration');

  console.log('\n========================================================================');
  console.log(`🎉 PHASE 5 VERIFICATION COMPLETE: ${passed}/${total} TESTS PASSED!`);
  console.log('========================================================================\n');
}

main()
  .catch(e => {
    console.error('Phase 5 verification failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
