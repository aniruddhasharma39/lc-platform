import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { bumpDirectoryRevision } from '../src/lib/revisionManager';
import { bumpReportRevision } from '../src/lib/reportRevisionManager';
import { parseGateStateFromPayload } from '../src/lib/telemetryMonitor';

async function seedGatesAndEvents() {
  console.log('Ensuring LC Gates and Real Telemetry synchronization (NO FAKE DATA)...');

  const createdGates = await prisma.lCGate.findMany();
  console.log(`Found ${createdGates.length} active LC Gates.`);

  // 1. Sync real telemetry from AWS IoT (DeviceTelemetry) into LCGateEvent
  const realTelemetry = await prisma.deviceTelemetry.findMany({
    where: {
      thingName: 'LC-M-001'
    },
    orderBy: { receivedAt: 'asc' }
  });

  if (realTelemetry.length > 0) {
    console.log(`Found ${realTelemetry.length} real physical telemetry records for LC-M-001 from AWS IoT.`);
    
    // Find gate linked to LC-M-001
    const dev = await prisma.deviceRegistry.findFirst({
      where: { thingName: 'LC-M-001' },
      select: { gateId: true }
    });

    const targetGateId = dev?.gateId || (createdGates.find(g => g.lcNumber === 'LC-30')?.id || createdGates[0]?.id);

    if (targetGateId) {
      let transitions: any[] = [];
      let prevState: string | null = null;

      for (const r of realTelemetry) {
        const state = parseGateStateFromPayload(r.payload);
        if (!state) continue;

        if (state !== prevState) {
          transitions.push({
            id: r.id,
            receivedAt: r.receivedAt,
            state,
            payload: r.payload
          });
          prevState = state;
        }
      }

      // Check existing events count
      const existingCount = await prisma.lCGateEvent.count({
        where: { gateId: targetGateId }
      });

      if (existingCount === 0) {
        const realEventsToCreate: any[] = [];
        let currentOpen: any = null;

        for (const tr of transitions) {
          if (tr.state === 'OPEN') {
            currentOpen = tr;
          } else if (tr.state === 'CLOSED' && currentOpen) {
            const openTime = new Date(currentOpen.receivedAt);
            const closeTime = new Date(tr.receivedAt);
            const durationSeconds = Math.max(0, Math.round((closeTime.getTime() - openTime.getTime()) / 1000));
            const status = durationSeconds > 900 ? 'EXTENDED_DELAY' : 'CLOSED';

            realEventsToCreate.push({
              gateId: targetGateId,
              openedAt: openTime,
              closedAt: closeTime,
              durationSeconds,
              status,
              openedBy: 'AWS IoT / LC-M-001',
              closedBy: 'AWS IoT / LC-M-001',
              trainNumber: null,
              remarks: 'Physical LimitSwitch transition detected via AWS IoT Telemetry'
            });
            currentOpen = null;
          }
        }

        if (realEventsToCreate.length > 0) {
          await prisma.lCGateEvent.createMany({
            data: realEventsToCreate
          });
          console.log(`Synced ${realEventsToCreate.length} real AWS telemetry events for Gate #${targetGateId}.`);
        }
      }
    }
  }

  // Bump revisions
  await bumpDirectoryRevision([], true);
  for (const g of createdGates) {
    await bumpReportRevision(g.id);
  }
  console.log('Bumped directory and report revisions.');
}

seedGatesAndEvents()
  .then(() => {
    console.log('Gate & Real Telemetry sync completed successfully!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Sync failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
