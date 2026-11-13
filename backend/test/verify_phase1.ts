import { prisma } from '../src/lib/prisma';
import { getDesignationConfig } from '../src/lib/railwayHierarchy';

async function main() {
  console.log('========================================================================');
  console.log('🚀 RUNNING PHASE 1 DATABASE SCHEMA & HIERARCHY VERIFICATION');
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

  // 1. Roles & Seniority Levels
  console.log('--- 1. Engineering Department Roles in Database ---');
  const roleNames = ['Senior DEN', 'DEN', 'ADEN', 'CPWI', 'PWI', 'Restkeeper', 'Gateman'];
  const roles = await prisma.role.findMany({
    where: {
      name: { in: roleNames }
    }
  });

  const foundRoleNames = new Set(roles.map(r => r.name));
  for (const name of roleNames) {
    assert(foundRoleNames.has(name), `Role "${name}" exists in database`);
  }

  console.log('\n--- 2. Seniority & Hierarchy Ordering in Engineering Department ---');
  const srDen = getDesignationConfig('Senior DEN');
  const den = getDesignationConfig('DEN');
  const aden = getDesignationConfig('ADEN');
  const cpwi = getDesignationConfig('CPWI');
  const pwi = getDesignationConfig('PWI');
  const restkeeper = getDesignationConfig('Restkeeper');
  const gateman = getDesignationConfig('Gateman');

  assert(!!srDen && srDen.seniority === 1, 'Senior DEN seniority rank is 1');
  assert(!!den && den.seniority === 2, 'DEN seniority rank is 2');
  assert(!!aden && aden.seniority === 3, 'ADEN seniority rank is 3');
  assert(!!cpwi && cpwi.seniority === 4, 'CPWI seniority rank is 4');
  assert(!!pwi && pwi.seniority === 5, 'PWI seniority rank is 5');
  assert(!!restkeeper && restkeeper.seniority === 6, 'Restkeeper seniority rank is 6');
  assert(!!gateman && gateman.seniority === 7, 'Gateman seniority rank is 7');

  // Verify hierarchy link / superior chain
  assert(pwi.immediateSuperior === 'CPWI', 'PWI immediate superior is CPWI');
  assert(restkeeper.immediateSuperior === 'PWI', 'Restkeeper immediate superior is PWI');
  assert(restkeeper.level === 'STATION', 'Restkeeper level is STATION (multi-gate under station)');

  assert(
    srDen.seniority < den.seniority &&
    den.seniority < aden.seniority &&
    aden.seniority < cpwi.seniority &&
    cpwi.seniority < pwi.seniority &&
    pwi.seniority < restkeeper.seniority &&
    restkeeper.seniority < gateman.seniority,
    'Strict hierarchy ordering: Sr. DEN (1) < DEN (2) < ADEN (3) < CPWI (4) < PWI (5) < Restkeeper (6) < Gateman (7)'
  );

  // 3. Database Models Check
  console.log('\n--- 3. Database Tables & Relations Verification ---');
  const shiftConfigCount = await prisma.gateShiftConfig.count();
  assert(typeof shiftConfigCount === 'number', 'Table "GateShiftConfig" exists and is queryable');

  const dutyRosterCount = await prisma.gateDutyRoster.count();
  assert(typeof dutyRosterCount === 'number', 'Table "GateDutyRoster" exists and is queryable');

  // 4. User & RegistrationRequest PME/RC Fields Check
  console.log('\n--- 4. PME & RC Fields in Schema ---');
  const user = await prisma.user.findFirst();
  assert(user !== null, 'Found user in database');
  assert('pmeDate' in (user || {}), 'User model contains pmeDate');
  assert('pmeExpiryDate' in (user || {}), 'User model contains pmeExpiryDate');
  assert('pmeCertificateNo' in (user || {}), 'User model contains pmeCertificateNo');
  assert('rcDate' in (user || {}), 'User model contains rcDate');
  assert('rcExpiryDate' in (user || {}), 'User model contains rcExpiryDate');
  assert('rcInstitute' in (user || {}), 'User model contains rcInstitute');

  console.log('\n========================================================================');
  console.log(`🎉 PHASE 1 VERIFICATION COMPLETE: ${passed}/${total} TESTS PASSED!`);
  console.log('========================================================================\n');
}

main()
  .catch(e => {
    console.error('Phase 1 verification failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
