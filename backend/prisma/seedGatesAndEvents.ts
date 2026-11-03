import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { bumpDirectoryRevision } from '../src/lib/revisionManager';
import { bumpReportRevision } from '../src/lib/reportRevisionManager';

async function seedGatesAndEvents() {
  console.log('Seeding LC Gates, Scope Groups, and Historical Telemetry Events...');

  console.log('Role-based access mode: ensuring LC gates metadata...');

  // 2. Gates metadata
  const gatesData: any[] = [];

  const createdGates: any[] = [];
  for (const g of gatesData) {
    const existing = await prisma.lCGate.findUnique({ where: { id: g.id } });
    let gate;
    if (existing) {
      gate = existing;
    } else {
      gate = await prisma.lCGate.create({
        data: {
          id: g.id,
          lcNumber: g.lcNumber,
          name: g.name,
          locationName: g.locationName,
          zone: g.zone,
          division: g.division,
          latitude: 19.0 + (g.id * 0.01),
          longitude: 72.8 + (g.id * 0.01)
        }
      });
    }
    createdGates.push(gate);

    // Link gate directly to user access
    const allUsers = await prisma.user.findMany({ select: { id: true } });
    for (const u of allUsers) {
      await prisma.userGate.upsert({
        where: { userId_gateId: { userId: u.id, gateId: gate.id } },
        update: {},
        create: { userId: u.id, gateId: gate.id }
      }).catch(() => {});
    }

    // Ensure MasterUnit and ChildDevice
    let master = await prisma.masterUnit.findFirst({ where: { gateId: gate.id } });
    if (!master) {
      master = await prisma.masterUnit.create({
        data: {
          serialNumber: `MST-${g.lcNumber}`,
          masterSequence: 1,
          powerSource: 'SOLAR',
          gateId: gate.id,
        }
      });
      await prisma.childDevice.create({
        data: {
          serialNumber: `SLV-${g.lcNumber}-01`,
          type: 'DEVICE_1',
          deviceSequence: 1,
          masterId: master.id,
        }
      });
    }

    // Link device in DeviceRegistry to this gate
    await prisma.deviceRegistry.updateMany({
      where: { serialNumber: g.lcNumber },
      data: { gateId: gate.id, masterId: master.id }
    });
  }
  console.log(`Ensured ${createdGates.length} LC Gates created and mapped.`);

  // 3. Seed 35 days of realistic operational events
  const TRAIN_MOVEMENTS = [
    '12951 Mumbai Central - New Delhi Rajdhani Exp',
    '12952 New Delhi - Mumbai Rajdhani Exp',
    '12903 Golden Temple Mail',
    '12904 Golden Temple Mail (Down)',
    '19019 Bandra Terminus - Haridwar Dehradun Exp',
    '22914 BDTS Humsafar Express',
    '12925 Paschim Superfast Express',
    'Goods Freight DN-402 (Coal Rake)',
    'Goods Container UP-819 (CONCOR)',
    'Routine Road Traffic Clearance',
    'Track Maintenance Machine Movement',
    'Shunting Engine Movement (Yard to Main)'
  ];

  const OPERATORS = [
    'Gatesman Rajesh Sharma',
    'Gatesman Arvind Patel',
    'Gatesman Mukesh Meena',
    'Station Master K. K. Verma',
    'Station Master S. N. Trivedi',
    'Auto-Interlock / Track Circuit Trigger',
    'Section Traffic Controller'
  ];

  const now = new Date();
  const eventsToCreate: any[] = [];

  for (let dayOffset = 35; dayOffset >= 0; dayOffset--) {
    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() - dayOffset);

    for (const gate of createdGates) {
      const seedValue = (gate.id * 37 + dayOffset * 17) % 5;
      const operationsToday = 4 + seedValue; // 4 to 8 operations per day
      const stepHours = 24 / operationsToday;

      for (let opIdx = 0; opIdx < operationsToday; opIdx++) {
        const hour = Math.floor(opIdx * stepHours) % 24;
        const minute = (opIdx * 19 + gate.id * 7) % 60;
        const second = (opIdx * 11) % 60;

        const openedAt = new Date(targetDate);
        openedAt.setHours(hour, minute, second, 0);

        if (openedAt > now) continue;

        const isDelayed = (opIdx + dayOffset) % 7 === 0;
        const durationSeconds = isDelayed
          ? 960 + ((opIdx * 33) % 400) // 16 to 22 mins
          : 240 + ((opIdx * 47) % 480); // 4 to 12 mins

        const closedAt = new Date(openedAt.getTime() + durationSeconds * 1000);

        // If today and very recent (within 10 mins), leave open
        const isCurrentlyOpen = dayOffset === 0 && opIdx === operationsToday - 1 && (now.getTime() - openedAt.getTime()) < 10 * 60 * 1000;

        const trainIdx = (gate.id + dayOffset + opIdx) % TRAIN_MOVEMENTS.length;
        const operatorIdx = (gate.id * 2 + opIdx) % OPERATORS.length;

        eventsToCreate.push({
          gateId: gate.id,
          openedAt,
          closedAt: isCurrentlyOpen ? null : (closedAt > now ? now : closedAt),
          durationSeconds: isCurrentlyOpen ? null : Math.round((Math.min(closedAt.getTime(), now.getTime()) - openedAt.getTime()) / 1000),
          status: isCurrentlyOpen ? 'OPEN' : (isDelayed ? 'EXTENDED_DELAY' : 'CLOSED'),
          openedBy: OPERATORS[operatorIdx],
          closedBy: isCurrentlyOpen ? null : OPERATORS[operatorIdx],
          trainNumber: TRAIN_MOVEMENTS[trainIdx],
          remarks: isDelayed
            ? 'Road traffic congestion cleared before barrier locking'
            : (isCurrentlyOpen ? 'Barrier raised for road transit clearance' : 'Standard railway block clearance completed safely')
        });
      }
    }
  }

  if (eventsToCreate.length > 0) {
    await prisma.lCGateEvent.createMany({
      data: eventsToCreate,
      skipDuplicates: true
    });
    console.log(`Seeded ${eventsToCreate.length} operational events!`);
  }

  // Bump revisions
  await bumpDirectoryRevision([], true);
  for (const g of createdGates) {
    await bumpReportRevision(g.id);
  }
  console.log('Bumpped directory and report revisions.');
}

seedGatesAndEvents()
  .then(() => {
    console.log('Seeding completed successfully!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
