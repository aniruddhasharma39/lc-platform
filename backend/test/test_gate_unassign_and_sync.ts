import assert from 'assert';
import { prisma } from '../src/lib/prisma';
import { getGateTelemetryPayload } from '../src/lib/telemetryWs';

async function testGateUnassignAndSync() {
  console.log('🧪 Testing Gate Unassign, Zero-Phantom Records & Dynamic Device Sync...');

  // 1. Find gate LC-30
  let gate30 = await prisma.lCGate.findFirst({ where: { lcNumber: 'LC-30' } });
  if (!gate30) {
    gate30 = await prisma.lCGate.create({
      data: {
        lcNumber: 'LC-30',
        locationName: 'Kasu',
        zone: 'Central Railway',
        division: 'Mumbai CST'
      }
    });
  }

  // Ensure LC-30 is completely unassigned (no masters)
  const existingMasters = await prisma.masterUnit.findMany({ where: { gateId: gate30.id } });
  for (const m of existingMasters) {
    await prisma.deviceRegistry.updateMany({
      where: { masterId: m.id },
      data: { masterId: null, gateId: null }
    });
    await prisma.masterUnit.delete({ where: { id: m.id } });
  }

  // Ensure any orphan events on gate 30 are deleted
  await prisma.lCGateEvent.deleteMany({ where: { gateId: gate30.id } });

  // TEST 1: Unconfigured gate must return 0 operational cycles
  console.log('\n--- TEST 1: Verify Unconfigured Gate LC-30 has ZERO operational cycles ---');
  const unconfiguredTelemetry: any = await getGateTelemetryPayload(gate30.id);
  assert(unconfiguredTelemetry !== null, 'Telemetry payload should exist');
  assert.strictEqual(unconfiguredTelemetry.hasMaster, false, 'hasMaster must be false');
  assert.strictEqual(unconfiguredTelemetry.deviceStatus, 'UNCONFIGURED', 'deviceStatus must be UNCONFIGURED');
  assert.strictEqual(unconfiguredTelemetry.operationalCycles.length, 0, 'operationalCycles must be strictly empty []');
  assert.strictEqual(unconfiguredTelemetry.counts.cycles, 0, 'counts.cycles must be 0');
  console.log('✅ TEST 1 PASSED: Unconfigured gate returns exactly 0 operational cycles.');

  // TEST 2: Assign master unit with AWS IoT device LC-M-001
  console.log('\n--- TEST 2: Dynamically Link AWS IoT Device LC-M-001 to Gate LC-30 ---');
  const dev = await prisma.deviceRegistry.findFirst({ where: { thingName: 'LC-M-001' } });
  assert(dev !== null, 'Device LC-M-001 must exist in DeviceRegistry');

  // Simulate user creating Master Unit via API
  const master = await prisma.$transaction(async (tx) => {
    const created = await tx.masterUnit.create({
      data: {
        serialNumber: 'LC-30-01',
        masterSequence: 1,
        powerSource: 'DIRECT',
        gateId: gate30!.id
      }
    });

    await tx.deviceRegistry.update({
      where: { id: dev.id },
      data: { masterId: created.id, gateId: gate30!.id }
    });

    // Device telemetry sync
    const telemetries = await tx.deviceTelemetry.findMany({
      where: {
        thingName: dev.thingName,
        topic: { contains: '/telemetry' }
      },
      orderBy: { receivedAt: 'asc' }
    });

    const eventsToCreate: any[] = [];
    let currentOpen: { openedAt: Date; openedBy: string } | null = null;

    for (const t of telemetries) {
      const p = t.payload as any;
      if (!p) continue;
      let isClosed = true;
      if (p.LimitSwitchClosed !== undefined) {
        isClosed = Boolean(p.LimitSwitchClosed);
      } else if (p.Status) {
        isClosed = String(p.Status).trim().toUpperCase() === 'CLOSED';
      }

      if (!isClosed && !currentOpen) {
        currentOpen = { openedAt: new Date(t.receivedAt), openedBy: `AWS IoT / ${dev.thingName}` };
      } else if (isClosed && currentOpen) {
        const closedAt = new Date(t.receivedAt);
        const durationSeconds = Math.max(1, Math.round((closedAt.getTime() - currentOpen.openedAt.getTime()) / 1000));
        eventsToCreate.push({
          gateId: gate30!.id,
          openedAt: currentOpen.openedAt,
          closedAt,
          durationSeconds,
          status: durationSeconds > 900 ? 'EXTENDED_DELAY' : 'CLOSED',
          openedBy: currentOpen.openedBy,
          closedBy: `AWS IoT / ${dev.thingName}`,
          remarks: 'Physical LimitSwitch transition detected via AWS IoT Telemetry'
        });
        currentOpen = null;
      }
    }

    if (eventsToCreate.length > 0) {
      await tx.lCGateEvent.createMany({ data: eventsToCreate });
    }

    return created;
  });

  const configuredTelemetry = await getGateTelemetryPayload(gate30.id);
  assert(configuredTelemetry !== null, 'Configured telemetry should exist');
  assert.strictEqual(configuredTelemetry.hasMaster, true, 'hasMaster must be true');
  assert(configuredTelemetry.operationalCycles.length >= 25, `Should have genuine physical cycles from LC-M-001 (got ${configuredTelemetry.operationalCycles.length})`);
  console.log(`✅ TEST 2 PASSED: Gate LC-30 with assigned LC-M-001 has ${configuredTelemetry.operationalCycles.length} genuine cycles.`);

  // TEST 3: User deletes / unassigns the master unit
  console.log('\n--- TEST 3: User Unassigns/Deletes Master Unit from LC-30 ---');
  await prisma.$transaction(async (tx) => {
    await tx.deviceRegistry.updateMany({
      where: { masterId: master.id },
      data: { masterId: null, gateId: null }
    });
    await tx.masterUnit.delete({ where: { id: master.id } });

    // Clean up orphan events when no masters remain
    await tx.lCGateEvent.deleteMany({ where: { gateId: gate30!.id } });
  });

  const unassignedDev = await prisma.deviceRegistry.findUnique({ where: { id: dev.id } });
  assert.strictEqual(unassignedDev?.masterId, null, 'DeviceRegistry.masterId must be null');
  assert.strictEqual(unassignedDev?.gateId, null, 'DeviceRegistry.gateId must be null');

  const recheckedTelemetry: any = await getGateTelemetryPayload(gate30.id);
  assert(recheckedTelemetry !== null, 'Rechecked telemetry should exist');
  assert.strictEqual(recheckedTelemetry.hasMaster, false, 'hasMaster must be false after deletion');
  assert.strictEqual(recheckedTelemetry.deviceStatus, 'UNCONFIGURED', 'deviceStatus must be UNCONFIGURED');
  assert.strictEqual(recheckedTelemetry.operationalCycles.length, 0, 'operationalCycles must return to strictly empty []');
  assert.strictEqual(recheckedTelemetry.counts.cycles, 0, 'counts.cycles must be 0');
  console.log('✅ TEST 3 PASSED: After unassignment/deletion, gate returns strictly 0 operational cycles.');

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! No hardcoded assignments, zero phantom records.');
}

testGateUnassignAndSync()
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
