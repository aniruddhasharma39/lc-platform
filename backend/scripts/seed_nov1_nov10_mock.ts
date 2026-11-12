import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import {
  bumpReportRevisionInTx,
  deleteOperationalEventInTx,
  recordEventChangeInTx,
} from '../src/lib/reportRevisionManager';
import { bumpDirectoryRevision } from '../src/lib/revisionManager';

const MOCK_TAG = 'MOCK_NOV1_NOV10_2026';
const MOCK_HEALTH_PREFIX = 'mock_nov1_10_';
const TARGET_THINGS = ['LC-M-001', 'LC-M-002', 'LC-M-003', 'LC-M-004'] as const;
const IST_OFFSET_MS = 5.5 * 3600000;

interface PlannedCycle {
  dateStr: string;
  openedAt: Date;
  closedAt: Date;
  durationSeconds: number;
  status: 'CLOSED' | 'EXTENDED_DELAY';
  openedBy: string;
  closedBy: string;
  trainNumber: string;
}

interface PlannedDayHealth {
  dateStr: string;
  createdAt: Date;
  signalStrength: number;
  mcuTempC: number;
  batteryVoltage: number;
  batteryPercentage: number;
  solarVoltage: number;
  solarCharging: boolean;
  uptimeSeconds: number;
}

const TRAIN_LABELS = [
  '11029 Koyna Express',
  '12127 Intercity Express',
  '17317 Hubballi Express',
  '01023 Pune–Kolhapur MEMU',
  'Freight DN-408',
  '12051 Jan Shatabdi Exp',
  '16333 Veraval Express',
  '10103 Mandovi Express',
  '50103 Diva–Ratnagiri Pass',
  'Freight UP-214',
];

const OPERATORS = [
  'Automated',
  'Automated',
  'Automated',
  'Automated',
  'Interlock Auto',
];

function istDateTimeToUtc(
  year: number,
  month1Based: number,
  day: number,
  hourIst: number,
  minuteIst: number,
  secondIst = 0
): Date {
  const istAsUtcMs = Date.UTC(year, month1Based - 1, day, hourIst, minuteIst, secondIst, 0);
  return new Date(istAsUtcMs - IST_OFFSET_MS);
}

/**
 * Deterministic pseudo-random generator so each device gets distinct, realistic Nov 1–10 activity.
 */
function seededInt(seed: number, min: number, max: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  const frac = x - Math.floor(x);
  return min + Math.floor(frac * (max - min + 1));
}

function buildNov1To10Plan(deviceIndex: number): {
  cycles: PlannedCycle[];
  healthChecks: PlannedDayHealth[];
} {
  const cycles: PlannedCycle[] = [];
  const healthChecks: PlannedDayHealth[] = [];

  for (let day = 1; day <= 10; day++) {
    const dateStr = `2026-11-${String(day).padStart(2, '0')}`;
    const baseSeed = (deviceIndex + 1) * 1000 + day * 37;
    const cycleCount = seededInt(baseSeed, 4, 6); // 4–6 cycles per day

    // Spread cycles across 06:15 IST – 22:30 IST cleanly without overlaps
    const slotMinutes = Math.floor((16 * 60) / cycleCount);

    for (let c = 0; c < cycleCount; c++) {
      const s = baseSeed + c * 19;
      const startTotalMin = 6 * 60 + 15 + c * slotMinutes + seededInt(s + 1, 5, Math.max(10, slotMinutes - 35));
      const hourIst = Math.floor(startTotalMin / 60);
      const minuteIst = startTotalMin % 60;
      const secondIst = seededInt(s + 2, 0, 55);

      const isExtendedDelay = (day + c + deviceIndex) % 9 === 0;
      const durationSeconds = isExtendedDelay
        ? seededInt(s + 3, 960, 1260) // 16m – 21m (> 900s)
        : seededInt(s + 3, 135, 480); // 2m 15s – 8m

      const openedAt = istDateTimeToUtc(2026, 11, day, hourIst, minuteIst, secondIst);
      const closedAt = new Date(openedAt.getTime() + durationSeconds * 1000);

      cycles.push({
        dateStr,
        openedAt,
        closedAt,
        durationSeconds,
        status: durationSeconds > 900 ? 'EXTENDED_DELAY' : 'CLOSED',
        openedBy: OPERATORS[(day + c) % OPERATORS.length],
        closedBy: OPERATORS[(day + c) % OPERATORS.length],
        trainNumber: TRAIN_LABELS[(deviceIndex * 3 + day + c) % TRAIN_LABELS.length],
      });
    }

    const hs = baseSeed + 500;
    healthChecks.push({
      dateStr,
      createdAt: istDateTimeToUtc(2026, 11, day, 12 + (day % 3), seededInt(hs, 10, 50), 15),
      signalStrength: seededInt(hs + 1, 21, 30),
      mcuTempC: Number((31.5 + seededInt(hs + 2, 0, 65) / 10).toFixed(1)),
      batteryVoltage: Number((12.4 + seededInt(hs + 3, 0, 11) / 10).toFixed(2)),
      batteryPercentage: seededInt(hs + 4, 82, 98),
      solarVoltage: Number((16.8 + seededInt(hs + 5, 0, 24) / 10).toFixed(2)),
      solarCharging: true,
      uptimeSeconds: 3600 * (day * 24 + 6) + seededInt(hs + 6, 60, 1800),
    });
  }

  return { cycles, healthChecks };
}

async function resolveAssignedDevices() {
  const devs = await prisma.deviceRegistry.findMany({
    where: {
      OR: TARGET_THINGS.map((t) => ({ thingName: { equals: t, mode: 'insensitive' } })),
    },
    include: {
      gate: {
        select: {
          id: true,
          lcNumber: true,
          name: true,
          zone: true,
          division: true,
          locationName: true,
          station: { select: { name: true, code: true } },
        },
      },
      master: {
        select: { id: true, serialNumber: true, gateId: true, powerSource: true },
      },
    },
    orderBy: { thingName: 'asc' },
  });

  const byUpper = new Map(devs.map((d) => [d.thingName.toUpperCase(), d]));
  const missing = TARGET_THINGS.filter((t) => !byUpper.has(t));
  if (missing.length > 0) {
    throw new Error(`Missing DeviceRegistry records for: ${missing.join(', ')}`);
  }

  const unassigned = devs.filter((d) => !d.gateId || !d.masterId);
  if (unassigned.length > 0) {
    throw new Error(
      `All target devices must be assigned to a gate & master unit. Unassigned: ${unassigned
        .map((d) => d.thingName)
        .join(', ')}`
    );
  }

  return devs;
}

async function cleanExistingMockData(
  tx: Prisma.TransactionClient,
  devices: Awaited<ReturnType<typeof resolveAssignedDevices>>
) {
  const thingNames = devices.map((d) => d.thingName);

  const mockEvents = await tx.lCGateEvent.findMany({
    where: {
      thingName: { in: thingNames },
      remarks: { contains: MOCK_TAG },
    },
    select: { id: true },
  });

  for (const ev of mockEvents) {
    await deleteOperationalEventInTx(tx, ev.id);
  }

  const deletedTele = await tx.deviceTelemetry.deleteMany({
    where: {
      thingName: { in: thingNames },
      payload: {
        path: ['mockSeedTag'],
        equals: MOCK_TAG,
      },
    },
  });

  const deletedHealth = await tx.deviceHealthCheck.deleteMany({
    where: {
      thingName: { in: thingNames },
      requestId: { startsWith: MOCK_HEALTH_PREFIX },
    },
  });

  return {
    deletedEvents: mockEvents.length,
    deletedTelemetry: deletedTele.count,
    deletedHealthChecks: deletedHealth.count,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const shouldApply = args.has('--apply');
  const shouldCleanOnly = args.has('--clean');
  const shouldReset = args.has('--reset');
  const shouldCloseDanglingOpen = args.has('--close-dangling-open');

  const devices = await resolveAssignedDevices();

  console.log('\n=== Resolved Target Devices & Gate Assignments ===');
  for (const d of devices) {
    console.log(
      `- ${d.thingName} (devId=${d.id}) -> Gate ${d.gate?.lcNumber} (gateId=${d.gateId}, ${d.gate?.division} / ${d.gate?.station?.name || d.gate?.locationName}), Master ${d.master?.serialNumber} (masterId=${d.masterId})`
    );
  }

  if (shouldCleanOnly) {
    const cleaned = await prisma.$transaction(
      async (tx) => {
        const res = await cleanExistingMockData(tx, devices);
        await bumpDirectoryRevision([], true, tx);
        return res;
      },
      { maxWait: 10000, timeout: 60000 }
    );
    console.log('\n=== Cleaned Existing Mock Data ===');
    console.log(JSON.stringify(cleaned, null, 2));
    return;
  }

  const existingMockEventCount = await prisma.lCGateEvent.count({
    where: {
      thingName: { in: devices.map((d) => d.thingName) },
      remarks: { contains: MOCK_TAG },
    },
  });

  const danglingOpenEvents = await prisma.lCGateEvent.findMany({
    where: {
      gateId: { in: devices.map((d) => d.gateId!).filter(Boolean) },
      status: 'OPEN',
      closedAt: null,
    },
    select: { id: true, gateId: true, thingName: true, openedAt: true },
  });

  const plans = devices.map((dev, idx) => ({
    dev,
    ...buildNov1To10Plan(idx),
  }));

  console.log('\n=== Planned Mock Data (2026-11-01 to 2026-11-10 IST) ===');
  for (const p of plans) {
    const extCount = p.cycles.filter((c) => c.status === 'EXTENDED_DELAY').length;
    console.log(
      `- ${p.dev.thingName} (${p.dev.gate?.lcNumber}): ${p.cycles.length} cycles (${p.cycles.length * 2} telemetry packets, ${extCount} extended delays), ${p.healthChecks.length} health checks`
    );
  }
  console.log(`Existing ${MOCK_TAG} events in DB: ${existingMockEventCount}`);
  if (danglingOpenEvents.length > 0) {
    console.log(`Pre-existing unclosed OPEN events: ${JSON.stringify(danglingOpenEvents)}`);
  }

  if (!shouldApply) {
    console.log('\n[DRY-RUN] No database changes were made.');
    console.log('Run with "--apply" to insert mock data (or "--apply --reset" to replace, "--clean" to remove).');
    return;
  }

  if (existingMockEventCount > 0 && !shouldReset) {
    throw new Error(
      `Found ${existingMockEventCount} existing ${MOCK_TAG} events. Re-run with "--apply --reset" to replace cleanly, or "--clean" to remove.`
    );
  }

  const summary = await prisma.$transaction(
    async (tx) => {
      if (shouldReset && existingMockEventCount > 0) {
        await cleanExistingMockData(tx, devices);
      }

      if (shouldCloseDanglingOpen && danglingOpenEvents.length > 0) {
        for (const openEv of danglingOpenEvents) {
          const closedAt = new Date(openEv.openedAt.getTime() + 180 * 1000);
          const updated = await tx.lCGateEvent.update({
            where: { id: openEv.id },
            data: {
              closedAt,
              durationSeconds: 180,
              status: 'CLOSED',
              closedBy: 'Automated',
              remarks: 'Closed prior open cycle before Nov 1–10 backfill',
            },
          });
          await recordEventChangeInTx(tx, updated, 'UPDATE');
        }
      }

      let globalMaxTeleId = 0;
      const perDeviceResult: Array<{
        thingName: string;
        gateNumber: string;
        events: number;
        telemetry: number;
        health: number;
      }> = [];

      for (const p of plans) {
        const { dev, cycles, healthChecks } = p;
        const fw = dev.firmwareVersion || '1.0.8';
        const serial = dev.master?.serialNumber || dev.thingName;

        // 1. Bulk insert DeviceTelemetry rows (OPEN + CLOSED per cycle)
        const teleRows: Prisma.DeviceTelemetryCreateManyInput[] = [];
        for (const c of cycles) {
          teleRows.push({
            thingName: dev.thingName,
            topic: `lc-gate/${dev.thingName}/telemetry`,
            status: 'OPEN',
            receivedAt: c.openedAt,
            deviceRegistryId: dev.id,
            payload: {
              topic: `lc-gate/${dev.thingName}/telemetry`,
              Status: 'OPEN',
              DeviceType: 'LC_GATE_MASTER',
              HallClosed: false,
              LimitSwitchClosed: false,
              SensorType: 'None',
              TimeStampMs: Math.floor(c.openedAt.getTime() % 100000000),
              MasterDeviceId: dev.thingName,
              topicThingName: dev.thingName,
              FirmwareVersion: fw,
              mockSeedTag: MOCK_TAG,
            },
          });
          teleRows.push({
            thingName: dev.thingName,
            topic: `lc-gate/${dev.thingName}/telemetry`,
            status: 'CLOSED',
            receivedAt: c.closedAt,
            deviceRegistryId: dev.id,
            payload: {
              topic: `lc-gate/${dev.thingName}/telemetry`,
              Status: 'CLOSED',
              DeviceType: 'LC_GATE_MASTER',
              HallClosed: true,
              LimitSwitchClosed: true,
              SensorType: 'LimitSwitch',
              TimeStampMs: Math.floor(c.closedAt.getTime() % 100000000),
              MasterDeviceId: dev.thingName,
              topicThingName: dev.thingName,
              FirmwareVersion: fw,
              mockSeedTag: MOCK_TAG,
            },
          });
        }
        await tx.deviceTelemetry.createMany({ data: teleRows });

        const maxTeleForThing = await tx.deviceTelemetry.findFirst({
          where: { thingName: dev.thingName },
          orderBy: { id: 'desc' },
          select: { id: true },
        });
        const latestTeleId = Math.max(dev.lastTelemetryId || 0, maxTeleForThing?.id || 0);
        globalMaxTeleId = Math.max(globalMaxTeleId, latestTeleId);

        // 2. Bulk insert DeviceHealthCheck rows
        await tx.deviceHealthCheck.createMany({
          data: healthChecks.map((h) => {
            const reqId = `${MOCK_HEALTH_PREFIX}${dev.thingName.toLowerCase()}_${h.dateStr}`;
            return {
              thingName: dev.thingName,
              requestId: reqId,
              healthstatus: 'HEALTHY',
              gateStatus: 'CLOSED',
              boomAngle: 0,
              mcuTempC: h.mcuTempC,
              signalStrength: h.signalStrength,
              networkType: '4G_LTE',
              limitSwitchClosed: true,
              hallClosed: true,
              batteryVoltage: h.batteryVoltage,
              batteryPercentage: h.batteryPercentage,
              solarVoltage: h.solarVoltage,
              solarCharging: h.solarCharging,
              uptimeSeconds: h.uptimeSeconds,
              firmwareVersion: fw,
              deviceRegistryId: dev.id,
              createdAt: h.createdAt,
              rawPayload: {
                topic: `lc-gate/${dev.thingName}/health`,
                Status: 'CLOSED',
                action: 'HEALTH_CHECK_RESPONSE',
                requestId: reqId,
                healthstatus: 'HEALTHY',
                MasterDeviceId: dev.thingName,
                topicThingName: dev.thingName,
                NetworkType: '4G_LTE',
                SignalStrength: h.signalStrength,
                McuTempC: h.mcuTempC,
                BoomAngle: 0,
                LimitSwitchClosed: true,
                HallClosed: true,
                BatteryVoltage: h.batteryVoltage,
                BatteryPercentage: h.batteryPercentage,
                SolarVoltage: h.solarVoltage,
                SolarCharging: h.solarCharging,
                UptimeSeconds: h.uptimeSeconds,
                FirmwareVersion: fw,
                mockSeedTag: MOCK_TAG,
              },
            };
          }),
        });

        // 3. Bulk insert LCGateEvent rows + atomic ReportRevision & ChangeLog
        const eventRemark = `Physical LimitSwitch transition (${serial}) [${MOCK_TAG}]`;
        await tx.lCGateEvent.createMany({
          data: cycles.map((c) => ({
            gateId: dev.gateId!,
            masterId: dev.masterId!,
            masterSerial: dev.master?.serialNumber || null,
            thingName: dev.thingName,
            openedAt: c.openedAt,
            closedAt: c.closedAt,
            durationSeconds: c.durationSeconds,
            status: c.status,
            openedBy: c.openedBy,
            closedBy: c.closedBy,
            trainNumber: c.trainNumber,
            remarks: eventRemark,
          })),
        });

        const insertedEvents = await tx.lCGateEvent.findMany({
          where: {
            gateId: dev.gateId!,
            thingName: dev.thingName,
            remarks: eventRemark,
          },
          orderBy: { id: 'asc' },
        });

        const gateRevision = await bumpReportRevisionInTx(tx, dev.gateId!);
        await tx.lCGateEventChangeLog.createMany({
          data: insertedEvents.map((ev) => ({
            eventId: ev.id,
            gateId: ev.gateId,
            masterId: ev.masterId ?? null,
            masterSerial: ev.masterSerial ?? null,
            thingName: ev.thingName ?? null,
            opType: 'INSERT',
            gateRevision,
            status: ev.status ?? null,
            openedAt: ev.openedAt ?? null,
            closedAt: ev.closedAt ?? null,
            durationSeconds: ev.durationSeconds ?? null,
            openedBy: ev.openedBy ?? null,
            closedBy: ev.closedBy ?? null,
            trainNumber: ev.trainNumber ?? null,
            remarks: ev.remarks ?? null,
          })),
        });

        // 4. Monotonically update DeviceRegistry timestamps & barrierState
        const lastMockClosedAt = cycles[cycles.length - 1].closedAt;
        const lastMockHealthAt = healthChecks[healthChecks.length - 1].createdAt;
        const maxMockSeenAt =
          lastMockHealthAt.getTime() > lastMockClosedAt.getTime() ? lastMockHealthAt : lastMockClosedAt;

        const existingTeleAt = dev.lastTelemetryAt ? new Date(dev.lastTelemetryAt) : null;
        const existingSeenAt = dev.lastSeenAt ? new Date(dev.lastSeenAt) : null;

        const nextTeleAt =
          !existingTeleAt || lastMockClosedAt.getTime() >= existingTeleAt.getTime()
            ? lastMockClosedAt
            : existingTeleAt;
        const nextSeenAt =
          !existingSeenAt || maxMockSeenAt.getTime() >= existingSeenAt.getTime()
            ? maxMockSeenAt
            : existingSeenAt;
        const nextBarrierState =
          !existingTeleAt || lastMockClosedAt.getTime() >= existingTeleAt.getTime()
            ? 'CLOSED'
            : dev.barrierState;

        await tx.deviceRegistry.update({
          where: { id: dev.id },
          data: {
            lastTelemetryId: latestTeleId,
            lastTelemetryAt: nextTeleAt,
            lastSeenAt: nextSeenAt,
            barrierState: nextBarrierState,
          },
        });

        perDeviceResult.push({
          thingName: dev.thingName,
          gateNumber: dev.gate?.lcNumber || String(dev.gateId),
          events: insertedEvents.length,
          telemetry: teleRows.length,
          health: healthChecks.length,
        });
      }

      // Advance TELEMETRY_MONITOR_LAST_ID so EC2's live poller skips historical mock packets
      if (globalMaxTeleId > 0) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "AppSetting" ("key", "value")
           VALUES ('TELEMETRY_MONITOR_LAST_ID', '${globalMaxTeleId}')
           ON CONFLICT ("key") DO UPDATE
           SET "value" = GREATEST(CAST("AppSetting"."value" AS BIGINT), ${globalMaxTeleId})::TEXT;`
        );
      }

      await bumpDirectoryRevision([], true, tx);
      return { globalMaxTeleId, perDeviceResult };
    },
    { maxWait: 10000, timeout: 60000 }
  );

  console.log('\n=== Mock Data Applied Successfully ===');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error('\n[ERROR]', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
