import assert from 'assert';
import { prisma } from '../src/lib/prisma';
import { resolveGateAlertRecipients } from '../src/lib/railwayHierarchy';
import { checkAndDispatchGateStateAlert } from '../src/lib/gateAlertSms';

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 RUNNING TEST SUITE: Indian Railways Role-Based Alert Routing');
  console.log('===============================================================');

  // Verify database test gates exist
  const gate91 = await prisma.lCGate.findFirst({ where: { lcNumber: 'LC-91' } });
  const gate63 = await prisma.lCGate.findFirst({ where: { lcNumber: 'LC-63' } });
  const gate30 = await prisma.lCGate.findFirst({ where: { lcNumber: 'LC-30' } });

  assert(gate91, 'Gate LC-91 must exist in database');
  assert(gate63, 'Gate LC-63 must exist in database');
  assert(gate30, 'Gate LC-30 must exist in database');

  // --------------------------------------------------------------------------
  // TEST 1: Gate LC-91 (Targaon Station, Pune Division)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 1: Gate LC-91 (Targaon Station, Pune Division) ---');
  const res91 = await resolveGateAlertRecipients(gate91.id, prisma);
  assert(res91 !== null, 'Recipient resolution for LC-91 must return non-null result');

  const emails91 = res91.emailRecipients.map(r => r.email.toLowerCase());
  const phones91 = res91.smsRecipients.map(r => r.phone);

  console.log(`Gate LC-91 resolved ${res91.smsRecipients.length} SMS and ${res91.emailRecipients.length} Email recipients.`);

  // 1. Must include Raju Shinde (LC-91 Gateman)
  assert(emails91.includes('gateman.lc91@lcgate.in'), 'Raju Shinde (LC-91 Gateman) must receive LC-91 alert');
  assert(phones91.includes('9876543209'), 'Raju Shinde mobile 9876543209 must receive LC-91 SMS');

  // 2. Must include Mahesh Kulkarni (Targaon Station Master)
  assert(emails91.includes('sm.targaon@lcgate.in'), 'Mahesh Kulkarni (Targaon Station Master) must receive LC-91 alert');
  assert(phones91.includes('9876543204'), 'Mahesh Kulkarni mobile 9876543204 must receive LC-91 SMS');

  // 3. Must include all 6 Pune Divisional Officers
  const puneDivisionalEmails = [
    'srdom.pune@lcgate.in', // Senior DOM
    'dom.pune@lcgate.in',   // DOM
    'adom.pune@lcgate.in',  // ADOM/AOM
    'srden.pune@lcgate.in', // Senior DEN
    'den.pune@lcgate.in',   // DEN
    'aden.pune@lcgate.in'   // ADEN
  ];

  for (const divEmail of puneDivisionalEmails) {
    assert(emails91.includes(divEmail), `Pune Divisional Officer ${divEmail} must receive LC-91 alert`);
  }

  // 4. Must include System Admin
  assert(emails91.includes('admin@lcgate.in'), 'System Admin must receive LC-91 alert');

  // 5. Must STRICTLY EXCLUDE Satara staff & LC-63 Gateman
  assert(!emails91.includes('engsup.satara@lcgate.in'), 'Satara Engineering Supervisor must NOT receive LC-91 alert');
  assert(!emails91.includes('kp@gmail.com'), 'KP Singh Patel (LC-63 Gateman) must NOT receive LC-91 alert');

  console.log('✅ TEST 1 PASSED: LC-91 exact scoping verified.');

  // --------------------------------------------------------------------------
  // TEST 2: Gate LC-63 (Satara Station, Pune Division)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 2: Gate LC-63 (Satara Station, Pune Division) ---');
  const res63 = await resolveGateAlertRecipients(gate63.id, prisma);
  assert(res63 !== null, 'Recipient resolution for LC-63 must return non-null result');

  const emails63 = res63.emailRecipients.map(r => r.email.toLowerCase());
  const phones63 = res63.smsRecipients.map(r => r.phone);

  console.log(`Gate LC-63 resolved ${res63.smsRecipients.length} SMS and ${res63.emailRecipients.length} Email recipients.`);

  // 1. Must include KP Singh Patel (LC-63 Gateman)
  assert(emails63.includes('kp@gmail.com'), 'KP Singh Patel (LC-63 Gateman) must receive LC-63 alert');
  assert(phones63.includes('8808011010'), 'KP Singh Patel mobile 8808011010 must receive LC-63 SMS');

  // 2. Must include Ganesh Jadhav (Satara Engineering Supervisor)
  assert(emails63.includes('engsup.satara@lcgate.in'), 'Ganesh Jadhav (Satara Supervisor) must receive LC-63 alert');
  assert(phones63.includes('9876543208'), 'Ganesh Jadhav mobile 9876543208 must receive LC-63 SMS');

  // 3. Must include all 6 Pune Divisional Officers
  for (const divEmail of puneDivisionalEmails) {
    assert(emails63.includes(divEmail), `Pune Divisional Officer ${divEmail} must receive LC-63 alert`);
  }

  // 4. Must include System Admin
  assert(emails63.includes('admin@lcgate.in'), 'System Admin must receive LC-63 alert');

  // 5. Must STRICTLY EXCLUDE Targaon staff & LC-91 Gateman
  assert(!emails63.includes('sm.targaon@lcgate.in'), 'Targaon Station Master must NOT receive LC-63 alert');
  assert(!emails63.includes('gateman.lc91@lcgate.in'), 'Raju Shinde (LC-91 Gateman) must NOT receive LC-63 alert');

  console.log('✅ TEST 2 PASSED: LC-63 exact scoping verified.');

  // --------------------------------------------------------------------------
  // TEST 3: Gate LC-30 (Mumbai CST Division)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Gate LC-30 (Mumbai CST Division) ---');
  const res30 = await resolveGateAlertRecipients(gate30.id, prisma);
  assert(res30 !== null, 'Recipient resolution for LC-30 must return non-null result');

  const emails30 = res30.emailRecipients.map(r => r.email.toLowerCase());

  console.log(`Gate LC-30 resolved ${res30.smsRecipients.length} SMS and ${res30.emailRecipients.length} Email recipients.`);

  // Must include System Admin
  assert(emails30.includes('admin@lcgate.in'), 'System Admin must receive LC-30 alert');

  // Must STRICTLY EXCLUDE all Pune divisional officers, station masters, and gatemen
  for (const divEmail of puneDivisionalEmails) {
    assert(!emails30.includes(divEmail), `Pune Divisional Officer ${divEmail} must NOT receive Mumbai CST LC-30 alert`);
  }
  assert(!emails30.includes('sm.targaon@lcgate.in'), 'Targaon SM must NOT receive LC-30 alert');
  assert(!emails30.includes('engsup.satara@lcgate.in'), 'Satara Supervisor must NOT receive LC-30 alert');
  assert(!emails30.includes('gateman.lc91@lcgate.in'), 'Raju Shinde must NOT receive LC-30 alert');
  assert(!emails30.includes('kp@gmail.com'), 'KP Singh Patel must NOT receive LC-30 alert');

  console.log('✅ TEST 3 PASSED: Cross-divisional boundary isolation verified.');

  // --------------------------------------------------------------------------
  // TEST 4: End-to-End checkAndDispatchGateStateAlert Integration
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 4: End-to-End checkAndDispatchGateStateAlert Integration ---');
  const dispatchRes = await checkAndDispatchGateStateAlert({
    gateId: gate91.id,
    thingName: 'LC-91',
    newState: 'OPEN',
    timestamp: new Date()
  });

  assert(dispatchRes.dispatched > 0, 'Dispatch result must have dispatched > 0 SMS messages');
  assert.strictEqual(dispatchRes.lcNumber, 'LC-91', 'Dispatch result must match LC-91');
  assert.strictEqual(dispatchRes.newState, 'OPEN', 'Dispatch result must match OPEN');

  // Verify in GateStateAlertLog
  const latestLog = await prisma.gateStateAlertLog.findFirst({
    where: { gateId: gate91.id, status: 'OPEN' },
    orderBy: { id: 'desc' }
  });

  assert(latestLog !== null, 'GateStateAlertLog record must be created in database');
  assert.strictEqual(latestLog.lcNumber, 'LC-91');
  console.log(`✅ TEST 4 PASSED: End-to-end dispatch and audit logging verified (logged ID: ${latestLog.id}).`);

  console.log('\n===============================================================');
  console.log('🎉 ALL HIERARCHY ALERT TESTS PASSED SUCCESSFULLY (4/4)!');
  console.log('===============================================================');
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ TEST FAILED:', err);
    process.exit(1);
  });

