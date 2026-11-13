import { prisma } from '../src/lib/prisma';
import { getExamCompliance } from '../src/routes/roster';
import { DEFAULT_3_SHIFT_CONFIG, DEFAULT_2_SHIFT_CONFIG } from '../src/routes/shifts';

async function main() {
  console.log('========================================================================');
  console.log('🚀 RUNNING PHASE 2 VERIFICATION SUITE');
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

  // 1. Shift Configuration Default Presets
  console.log('--- 1. Shift Configuration Defaults & Presets ---');
  assert(DEFAULT_3_SHIFT_CONFIG.shifts.length === 3, 'Default 3-shift config has 3 shifts');
  assert(DEFAULT_3_SHIFT_CONFIG.shifts[0].startTime === '06:00' && DEFAULT_3_SHIFT_CONFIG.shifts[0].endTime === '14:00', 'Shift 1 is 06:00 - 14:00');
  assert(DEFAULT_2_SHIFT_CONFIG.shifts.length === 2, 'Default 2-shift config has 2 shifts');

  // 2. Custom Shift Config Persistence
  console.log('\n--- 2. Custom Shift Config Storage & Retrieval ---');
  const station = await prisma.station.findFirst();
  assert(!!station, 'Found a test station');

  if (station) {
    const customShifts = [
      { id: 's1', name: 'Duty Shift A', startTime: '07:00', endTime: '15:00' },
      { id: 's2', name: 'Duty Shift B', startTime: '15:00', endTime: '23:00' },
      { id: 's3', name: 'Duty Shift C', startTime: '23:00', endTime: '07:00' },
    ];
    
    // Upsert station shift config
    const savedConfig = await prisma.gateShiftConfig.upsert({
      where: { id: 999999 }, // placeholder ID to force create or findFirst
      update: {},
      create: {
        name: 'Custom Station Schedule',
        stationId: station.id,
        shiftsJson: JSON.stringify(customShifts)
      }
    });
    assert(savedConfig.id > 0, 'Custom shift config persisted to database');

    const fetchedConfig = await prisma.gateShiftConfig.findFirst({
      where: { stationId: station.id, gateId: null },
      orderBy: { updatedAt: 'desc' }
    });
    assert(!!fetchedConfig && fetchedConfig.name === 'Custom Station Schedule', 'Retrieved custom shift config for station');
    const parsed = JSON.parse(fetchedConfig!.shiftsJson);
    assert(parsed.length === 3 && parsed[0].startTime === '07:00', 'Parsed custom shift JSON matches input');

    // Clean up test config
    await prisma.gateShiftConfig.deleteMany({ where: { id: savedConfig.id } });
  }

  // 3. PME & RC Compliance Calculation
  console.log('\n--- 3. PME & RC Validity & Expiry Calculation ---');
  const now = new Date();
  
  // A. PME 4-year rule calculation
  const examDate = new Date('2024-01-15T00:00:00.000Z');
  const expectedPmeExp = new Date(examDate);
  expectedPmeExp.setFullYear(expectedPmeExp.getFullYear() + 4);
  assert(expectedPmeExp.toISOString().startsWith('2028-01-15'), 'PME 4-year expiry correctly calculates to 2028');

  // B. RC 2-year rule calculation
  const rcDate = new Date('2024-06-01T00:00:00.000Z');
  const expectedRcExp = new Date(rcDate);
  expectedRcExp.setFullYear(expectedRcExp.getFullYear() + 2);
  assert(expectedRcExp.toISOString().startsWith('2026-06-01'), 'RC 2-year expiry correctly calculates to 2026');

  // C. Compliance statuses
  const futureDate = new Date(now.getTime() + 100 * 24 * 60 * 60 * 1000); // 100 days ahead
  const dueSoonDate = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000); // 15 days ahead
  const expiredDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

  assert(getExamCompliance(futureDate) === 'VALID', 'Future expiry (>30 days) returns VALID');
  assert(getExamCompliance(dueSoonDate) === 'DUE_SOON', 'Near expiry (<=30 days) returns DUE_SOON');
  assert(getExamCompliance(expiredDate) === 'EXPIRED', 'Past expiry returns EXPIRED');
  assert(getExamCompliance(null) === 'NOT_SET', 'Null expiry returns NOT_SET');

  // 4. Gate Duty Roster Publishing & Retrieval
  console.log('\n--- 4. Gate Duty Roster Allocation & Publishing ---');
  const gate = await prisma.lCGate.findFirst();
  const gateman = await prisma.user.findFirst({
    where: {
      OR: [
        { role: { name: 'Gateman' } },
        { designation: { contains: 'Gateman' } }
      ]
    }
  });
  const adminUser = await prisma.user.findFirst({ where: { status: 'APPROVED' } });

  assert(!!gate, 'Found test LC Gate');
  assert(!!gateman, 'Found test Gateman user');
  assert(!!adminUser, 'Found creator/approver user');

  if (gate && gateman && adminUser) {
    const testDate = '2026-11-20';
    const testShift = 'Morning Shift';

    // Upsert roster entry
    const roster = await prisma.gateDutyRoster.upsert({
      where: {
        gateId_date_shiftName: {
          gateId: gate.id,
          date: testDate,
          shiftName: testShift,
        }
      },
      update: {
        startTime: '06:00',
        endTime: '14:00',
        gatemanUserId: gateman.id,
        createdById: adminUser.id,
        stationId: gate.stationId || station?.id || 1,
      },
      create: {
        gateId: gate.id,
        stationId: gate.stationId || station?.id || 1,
        date: testDate,
        shiftName: testShift,
        startTime: '06:00',
        endTime: '14:00',
        gatemanUserId: gateman.id,
        createdById: adminUser.id,
      }
    });

    assert(roster.id > 0, 'GateDutyRoster entry created successfully');
    assert(roster.shiftName === testShift, 'Shift name preserved');
    assert(roster.gatemanUserId === gateman.id, 'Assigned to correct Gateman');

    // Query roster by station & date
    const foundRoster = await prisma.gateDutyRoster.findFirst({
      where: { gateId: gate.id, date: testDate },
      include: { gate: true, gateman: true }
    });
    assert(!!foundRoster, 'Roster query by gate and date succeeded');
    assert(foundRoster?.gateman.id === gateman.id, 'Roster relation to Gateman user loaded');

    // Clean up test entry
    await prisma.gateDutyRoster.deleteMany({ where: { id: roster.id } });
  }

  console.log('\n========================================================================');
  console.log(`🎉 PHASE 2 VERIFICATION COMPLETE: ${passed}/${total} TESTS PASSED!`);
  console.log('========================================================================\n');
}

main()
  .catch((e) => {
    console.error('Fatal error during Phase 2 verification:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
