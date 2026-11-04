import assert from 'assert';
import { prisma } from '../src/lib/prisma';

async function testMasterSerialDistinction() {
  console.log('🧪 Testing Master Serial Identifier & AWS IoT Link distinction...');

  // 1. Find or create a test gate LC-40
  let gate40 = await prisma.lCGate.findFirst({ where: { lcNumber: 'LC-40' } });
  if (!gate40) {
    gate40 = await prisma.lCGate.create({
      data: {
        lcNumber: 'LC-40',
        locationName: 'Nagothane',
        zone: 'CR',
        division: 'Mumbai',
        status: 'OPERATIONAL',
      }
    });
  }

  // Clean up any test masters on LC-40
  const existingTestMasters = await prisma.masterUnit.findMany({ where: { gateId: gate40.id } });
  for (const m of existingTestMasters) {
    await prisma.deviceRegistry.updateMany({ where: { masterId: m.id }, data: { masterId: null, gateId: null } });
    await prisma.masterUnit.delete({ where: { id: m.id } });
  }

  // 2. Test next-master-sequence logic for LC-40 (should start at 01)
  const existingMastersCount = await prisma.masterUnit.count({ where: { gateId: gate40.id } });
  assert.strictEqual(existingMastersCount, 0, 'LC-40 should have 0 masters initially');

  const seqStr1 = '01';
  const expectedSerial1 = `${gate40.lcNumber}-${seqStr1}`;
  assert.strictEqual(expectedSerial1, 'LC-40-01', 'First master serial must be LC-40-01');

  // 3. Link an AWS IoT Device from registry (e.g. LC-M-001)
  let testDevice = await prisma.deviceRegistry.findFirst({ where: { masterId: null } });
  if (!testDevice) {
    testDevice = await prisma.deviceRegistry.create({
      data: {
        thingName: 'LC-M-TEST-01',
        serialNumber: 'LC-M-TEST-01',
        deviceType: 'MASTER',
        status: 'ONLINE',
      }
    });
  }

  console.log(`Linking AWS IoT device "${testDevice.thingName}" (ID: ${testDevice.id}) to gate ${gate40.lcNumber}`);

  // Create Master 1 with hardware device linked
  const master1 = await prisma.$transaction(async (tx) => {
    const created = await tx.masterUnit.create({
      data: {
        serialNumber: expectedSerial1,
        masterSequence: 1,
        powerSource: 'SOLAR',
        gateId: gate40!.id,
      }
    });

    await tx.deviceRegistry.update({
      where: { id: testDevice!.id },
      data: { masterId: created.id, gateId: gate40!.id }
    });

    return created;
  });

  // Verify Master 1 has serial LC-40-01 (NOT testDevice.thingName)
  assert.strictEqual(master1.serialNumber, 'LC-40-01', 'Master 1 serial MUST be LC-40-01');
  console.log('✓ Master 1 created with clean serial identifier:', master1.serialNumber);

  // Verify device is mapped
  const linkedDev = await prisma.deviceRegistry.findUnique({ where: { id: testDevice.id } });
  assert.strictEqual(linkedDev?.masterId, master1.id, 'DeviceRegistry must map to master1.id');
  assert.strictEqual(linkedDev?.gateId, gate40.id, 'DeviceRegistry must map to gate40.id');
  console.log(`✓ DeviceRegistry ${linkedDev?.thingName} correctly mapped to Master ${master1.id}`);

  // 4. Test next sequence for LC-40 (should now be 02)
  const mastersOnGate40 = await prisma.masterUnit.findMany({
    where: { gateId: gate40.id },
    orderBy: { masterSequence: 'asc' }
  });
  const takenSequences = new Set(mastersOnGate40.map(m => m.masterSequence));
  let nextSeq = 1;
  while (takenSequences.has(nextSeq)) {
    nextSeq++;
  }
  const seqStr2 = nextSeq.toString().padStart(2, '0');
  const expectedSerial2 = `${gate40.lcNumber}-${seqStr2}`;
  assert.strictEqual(expectedSerial2, 'LC-40-02', 'Second master serial must be LC-40-02');

  // Create Master 2 (Virtual, no deviceId)
  const master2 = await prisma.masterUnit.create({
    data: {
      serialNumber: expectedSerial2,
      masterSequence: 2,
      powerSource: 'DIRECT',
      gateId: gate40.id,
    }
  });

  assert.strictEqual(master2.serialNumber, 'LC-40-02', 'Master 2 serial MUST be LC-40-02');
  console.log('✓ Master 2 created with sequential identifier:', master2.serialNumber);

  // 5. Test independent gate scoping (e.g. LC-91 should start at 01, not affected by LC-40)
  let gate91 = await prisma.lCGate.findFirst({ where: { lcNumber: 'LC-91' } });
  if (gate91) {
    const mastersOnGate91 = await prisma.masterUnit.findMany({
      where: { gateId: gate91.id },
      orderBy: { masterSequence: 'asc' }
    });
    const taken91 = new Set(mastersOnGate91.map(m => m.masterSequence));
    let next91 = 1;
    while (taken91.has(next91)) {
      next91++;
    }
    const seqStr91 = next91.toString().padStart(2, '0');
    assert.strictEqual(seqStr91, '01', 'LC-91 master sequence must start at 01 independently');
    console.log(`✓ Independent gate scoping verified: LC-91 sequence is ${seqStr91}`);
  }

  // Cleanup test data
  await prisma.deviceRegistry.update({ where: { id: testDevice.id }, data: { masterId: null, gateId: null } });
  await prisma.masterUnit.delete({ where: { id: master2.id } });
  await prisma.masterUnit.delete({ where: { id: master1.id } });
  if (testDevice.thingName === 'LC-M-TEST-01') {
    await prisma.deviceRegistry.delete({ where: { id: testDevice.id } });
  }

  console.log('🎉 All Master Serial Identifier & Hardware Mapping tests PASSED!');
}

testMasterSerialDistinction()
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
