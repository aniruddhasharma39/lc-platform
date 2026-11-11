import { prisma } from './prisma';
import { checkAndDispatchGateStateAlert } from './gateAlertSms';
import { dispatchDeviceOfflineAdminEmails } from './emailService';
import { broadcastGateTelemetry } from './telemetryWs';
import { bumpReportRevisionInTx, recordEventChangeInTx } from './reportRevisionManager';
import {
  GATE_ONLINE_CUTOFF_MS,
  isGenuineTelemetryPacket,
  normalizeBarrierStateColumn,
  parseBarrierStateFromPayload,
} from './thingState';

let lastProcessedId = 0;
const lastKnownState = new Map<string, 'OPEN' | 'CLOSED'>();
let isPolling = false;

export const parseGateStateFromPayload = parseBarrierStateFromPayload;

/**
 * Records an operational gate event in LCGateEvent for the Reports section
 * when a physical or simulated telemetry transition occurs.
 */
export async function recordGateTelemetryTransition(params: {
  gateId?: number | null;
  masterId?: number | null;
  masterSerial?: string | null;
  thingName: string;
  newState: 'OPEN' | 'CLOSED';
  timestamp?: Date;
}) {
  try {
    const { gateId, thingName, newState } = params;
    const timestamp = params.timestamp || new Date();

    // 1. Resolve gate ID and master unit identity strictly from explicit assignment
    let targetGateId = gateId ?? null;
    let targetMasterId: number | null = params.masterId ?? null;
    let targetMasterSerial: string | null = params.masterSerial ?? null;

    if (!targetGateId || !targetMasterId || !targetMasterSerial) {
      const foundDev = await prisma.deviceRegistry.findUnique({
        where: { thingName },
        select: {
          id: true,
          gateId: true,
          masterId: true,
          master: { select: { id: true, serialNumber: true } },
        }
      });
      if (!targetGateId && foundDev?.gateId) {
        targetGateId = foundDev.gateId;
      }
      if (!targetMasterId && foundDev?.masterId) {
        targetMasterId = foundDev.masterId;
      }
      if (!targetMasterSerial && foundDev?.master?.serialNumber) {
        targetMasterSerial = foundDev.master.serialNumber;
      }
    }

    if (!targetGateId) {
      // Hardware device is unassigned or virtual. Do not record events for any gate.
      return null;
    }

    // Scope active open cycle matching by exact masterId (or null for gate-level) so multiple masters never collide
    const masterWhere = targetMasterId ? { masterId: targetMasterId } : { masterId: null };

    if (newState === 'OPEN') {
      // Check if this specific Master Unit already has an open event that hasn't closed yet
      const existingOpen = await prisma.lCGateEvent.findFirst({
        where: {
          gateId: targetGateId,
          ...masterWhere,
          status: 'OPEN',
          closedAt: null
        },
        orderBy: { openedAt: 'desc' }
      });

      if (!existingOpen) {
        return await prisma.$transaction(async (tx) => {
          const newEvent = await tx.lCGateEvent.create({
            data: {
              gateId: targetGateId!,
              masterId: targetMasterId,
              masterSerial: targetMasterSerial,
              thingName,
              openedAt: timestamp,
              status: 'OPEN',
              openedBy: 'Automated',
              remarks: targetMasterSerial
                ? `State transition: OPEN (${targetMasterSerial})`
                : `State transition: OPEN detected by IoT Telemetry`
            }
          });
          await recordEventChangeInTx(tx, newEvent, 'INSERT');
          console.log(`📊 [REPORTS] Logged OPEN event #${newEvent.id} for Gate #${targetGateId} / Master ${targetMasterSerial || thingName}`);
          return newEvent;
        });
      }
      return existingOpen;
    } else if (newState === 'CLOSED') {
      // Find latest OPEN event strictly for this specific Master Unit on this gate
      const openEvent = await prisma.lCGateEvent.findFirst({
        where: {
          gateId: targetGateId,
          ...masterWhere,
          status: 'OPEN',
          closedAt: null
        },
        orderBy: { openedAt: 'desc' }
      });

      if (openEvent) {
        const durationSeconds = Math.max(0, Math.round((timestamp.getTime() - openEvent.openedAt.getTime()) / 1000));
        const finalStatus = durationSeconds > 900 ? 'EXTENDED_DELAY' : 'CLOSED';

        return await prisma.$transaction(async (tx) => {
          const updated = await tx.lCGateEvent.update({
            where: { id: openEvent.id },
            data: {
              closedAt: timestamp,
              durationSeconds,
              status: finalStatus,
              closedBy: 'Automated',
              masterId: openEvent.masterId ?? targetMasterId,
              masterSerial: openEvent.masterSerial ?? targetMasterSerial,
              thingName: openEvent.thingName ?? thingName,
              remarks: openEvent.remarks ? `${openEvent.remarks} | Closed via IoT Telemetry` : `Closed via IoT Telemetry`
            }
          });
          await recordEventChangeInTx(tx, updated, 'UPDATE');
          console.log(`📊 [REPORTS] Updated CLOSED event #${updated.id} for Gate #${targetGateId} / Master ${targetMasterSerial || thingName}, duration: ${durationSeconds}s`);
          return updated;
        });
      } else {
        // First telemetry state seen on boot/cold-start is CLOSED with no prior OPEN cycle:
        // do NOT fabricate a synthetic 180s cycle; wait for a real OPEN -> CLOSED transition.
        return null;
      }
    }
  } catch (err: any) {
    console.error('Error recording gate telemetry event for reports:', err?.message || err);
    return null;
  }
}

/**
 * Backfills / synchronizes historical telemetry events into LCGateEvent
 * so all past OPEN/CLOSED operations are available in the Reports section.
 */
export async function syncHistoricalTelemetryEvents(specificGateId?: number) {
  try {
    const existingEventsCount = await prisma.lCGateEvent.count(
      specificGateId ? { where: { gateId: specificGateId } } : undefined
    );

    // 1. Fetch devices with their linked gate and master unit
    const devices = await prisma.deviceRegistry.findMany({
      where: specificGateId ? { gateId: specificGateId } : { gateId: { not: null } },
      select: {
        id: true,
        thingName: true,
        gateId: true,
        masterId: true,
        master: { select: { id: true, serialNumber: true } },
      }
    });

    if (devices.length === 0) {
      return { synced: 0, existing: existingEventsCount };
    }

    let totalSynced = 0;

    for (const dev of devices) {
      if (!dev.gateId) continue;

      // Skip backfill for this specific device/master if it already has events (unless gate explicitly requested)
      if (!specificGateId) {
        const masterEventCount = await prisma.lCGateEvent.count({
          where: {
            gateId: dev.gateId,
            ...(dev.masterId ? { masterId: dev.masterId } : { thingName: dev.thingName })
          }
        });
        if (masterEventCount > 0) continue;
      }

      const masterSerial = dev.master?.serialNumber || null;

      const rawRecords = await prisma.deviceTelemetry.findMany({
        where: {
          OR: [
            { thingName: dev.thingName },
            { deviceRegistryId: dev.id },
          ],
          topic: { contains: '/telemetry' },
        },
        orderBy: { receivedAt: 'asc' }
      });

      const records = rawRecords.filter(isGenuineTelemetryPacket);
      if (records.length === 0) continue;

      let prevState: 'OPEN' | 'CLOSED' | null = null;
      let currentOpenEventId: number | null = null;
      let openTimestamp: Date | null = null;

      for (const r of records) {
        const state = parseGateStateFromPayload(r.payload);
        if (!state) continue;

        if (state !== prevState) {
          const timestamp = new Date(r.receivedAt);

          if (state === 'OPEN') {
            await prisma.$transaction(async (tx) => {
              const ev = await tx.lCGateEvent.create({
                data: {
                  gateId: dev.gateId!,
                  masterId: dev.masterId,
                  masterSerial,
                  thingName: dev.thingName,
                  openedAt: timestamp,
                  status: 'OPEN',
                  openedBy: 'Automated',
                  remarks: masterSerial
                    ? `State transition: OPEN (${masterSerial})`
                    : `State transition: OPEN detected by IoT Telemetry`
                }
              });
              await recordEventChangeInTx(tx, ev, 'INSERT');
              currentOpenEventId = ev.id;
            });
            openTimestamp = timestamp;
            totalSynced++;
          } else if (state === 'CLOSED') {
            if (currentOpenEventId && openTimestamp) {
              const durationSeconds = Math.max(0, Math.round((timestamp.getTime() - openTimestamp.getTime()) / 1000));
              const finalStatus = durationSeconds > 900 ? 'EXTENDED_DELAY' : 'CLOSED';

              await prisma.$transaction(async (tx) => {
                const updated = await tx.lCGateEvent.update({
                  where: { id: currentOpenEventId! },
                  data: {
                    closedAt: timestamp,
                    durationSeconds,
                    status: finalStatus,
                    closedBy: 'Automated',
                    remarks: masterSerial
                      ? `State transition: CLOSED (${masterSerial})`
                      : `State transition: CLOSED detected by IoT Telemetry`
                  }
                });
                await recordEventChangeInTx(tx, updated, 'UPDATE');
              });
              currentOpenEventId = null;
              openTimestamp = null;
            }
            // Do not synthesize fake 180s cycles if history began in CLOSED state
          }
          prevState = state;
        }
      }
    }

    console.log(`📊 [REPORTS SYNC] Successfully synced ${totalSynced} operational events from historical telemetry stream.`);
    return { synced: totalSynced, existing: existingEventsCount };
  } catch (err: any) {
    console.error('Error syncing historical telemetry events:', err?.message || err);
    return { synced: 0, error: err?.message };
  }
}

/**
 * Initializes the monitor by capturing current state so past history doesn't trigger alerts
 */
export async function initTelemetryMonitor() {
  try {
    const latestTele = await prisma.deviceTelemetry.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true }
    });

    if (latestTele) {
      lastProcessedId = latestTele.id;
    }

    // Seed latest known states strictly from DeviceRegistry.barrierState (populated from genuine /telemetry)
    const devices = await prisma.deviceRegistry.findMany({
      select: { id: true, thingName: true, barrierState: true }
    });

    for (const d of devices) {
      const dbState = normalizeBarrierStateColumn(d.barrierState);
      if (dbState) {
        lastKnownState.set(d.thingName, dbState);
      } else {
        const lastTele = await prisma.deviceTelemetry.findFirst({
          where: {
            OR: [
              { deviceRegistryId: d.id },
              { thingName: d.thingName }
            ],
            topic: { contains: '/telemetry' },
            NOT: [
              { topic: { contains: '/health' } },
              { topic: { contains: '/request' } }
            ],
          },
          orderBy: { receivedAt: 'desc' }
        });

        if (lastTele && isGenuineTelemetryPacket(lastTele)) {
          const state = parseGateStateFromPayload(lastTele.payload);
          if (state) {
            lastKnownState.set(d.thingName, state);
          }
        }
      }
    }

    console.log(`📡 [TELEMETRY MONITOR] Initialized at telemetry ID ${lastProcessedId}. Tracking ${lastKnownState.size} device states.`);

    // Backfill historical telemetry transitions into LCGateEvent if empty
    await syncHistoricalTelemetryEvents();
  } catch (err: any) {
    console.error('Failed to initialize telemetry monitor:', err?.message || err);
  }
}

/**
 * Checks for new telemetry entries inserted by AWS Lambda or API and detects state transitions
 */
export async function pollTelemetryTransitions() {
  if (isPolling) return;
  isPolling = true;

  try {
    const newRecords = await prisma.deviceTelemetry.findMany({
      where: { id: { gt: lastProcessedId } },
      orderBy: { id: 'asc' },
      take: 50,
    });

    for (const record of newRecords) {
      lastProcessedId = Math.max(lastProcessedId, record.id);

      const thingName = record.thingName;
      if (!thingName) continue;

      if (!isGenuineTelemetryPacket(record)) continue;

      const currentState = parseGateStateFromPayload(record.payload);
      if (!currentState) continue;

      // Sync DeviceRegistry authoritative state if packet bypassed POST /telemetry (e.g. Lambda insert)
      const device = await prisma.deviceRegistry.findUnique({
        where: { thingName },
        include: {
          master: { select: { id: true, serialNumber: true } }
        }
      });

      if (device && (device.barrierState !== currentState || !device.lastTelemetryAt || new Date(record.receivedAt) > new Date(device.lastTelemetryAt))) {
        await prisma.deviceRegistry.update({
          where: { id: device.id },
          data: {
            connectivityStatus: 'ONLINE',
            lastSeenAt: record.receivedAt || new Date(),
            barrierState: currentState,
            lastTelemetryAt: record.receivedAt || new Date(),
            lastTelemetryId: record.id,
          },
        }).catch(() => {});
      }

      const prevState = lastKnownState.get(thingName) ?? normalizeBarrierStateColumn(device?.barrierState);

      // Transition detected! (e.g., OPEN ➔ CLOSED or CLOSED ➔ OPEN)
      if (prevState !== currentState) {
        console.log(`⚡ [TELEMETRY MONITOR] State transition detected for "${thingName}": ${prevState || 'INITIAL'} ➔ ${currentState}`);

        if (prevState && currentState === 'OPEN') {
          // Trigger SMS/Email alert asynchronously only when gate transitions to OPEN (normal CLOSED alerts disabled)
          checkAndDispatchGateStateAlert({
            deviceId: device?.id,
            gateId: device?.gateId,
            masterId: device?.masterId,
            masterSerial: device?.master?.serialNumber || null,
            thingName,
            serialNumber: device?.serialNumber || thingName,
            newState: currentState,
            timestamp: record.receivedAt || new Date(),
          }).catch(err => console.error('Error dispatching alert from telemetry monitor:', err));
        }

        // Log operational event for the Reports section
        if (device?.gateId) {
          broadcastGateTelemetry(device.gateId).catch(console.warn);
        }
        recordGateTelemetryTransition({
          gateId: device?.gateId,
          masterId: device?.masterId,
          masterSerial: device?.master?.serialNumber || null,
          thingName,
          newState: currentState,
          timestamp: record.receivedAt || new Date(),
        }).catch(err => console.error('Error recording telemetry event for reports:', err));
      } else if (device?.gateId) {
        broadcastGateTelemetry(device.gateId).catch(console.warn);
      }

      // Update in-memory tracker
      lastKnownState.set(thingName, currentState);
    }
  } catch (err: any) {
    console.error('Error in pollTelemetryTransitions:', err?.message || err);
  } finally {
    isPolling = false;
  }
}

/**
 * 65-Minute Rule: Periodic Heartbeat is 1 hour (3600s) + 5 min network grace period.
 * If no message received for > 65 minutes, background worker marks device status = "OFFLINE".
 */
export async function checkAndMarkOfflineDevices() {
  const cutoffDate = new Date(Date.now() - GATE_ONLINE_CUTOFF_MS);

  try {
    const candidates = await prisma.deviceRegistry.findMany({
      where: {
        connectivityStatus: 'ONLINE',
        OR: [
          { lastSeenAt: { lt: cutoffDate } },
          { lastSeenAt: null }
        ]
      },
      select: {
        id: true,
        thingName: true,
        lastSeenAt: true,
        gate: { select: { lcNumber: true, locationName: true, zone: true, division: true } },
        master: { select: { serialNumber: true } },
      }
    });

    if (candidates.length === 0) return;

    const result = await prisma.deviceRegistry.updateMany({
      where: {
        id: { in: candidates.map((d) => d.id) },
        connectivityStatus: 'ONLINE',
      },
      data: {
        connectivityStatus: 'OFFLINE'
      }
    });

    if (result.count > 0) {
      console.log(`📡 [DEVICE STATUS WORKER] Marked ${result.count} devices as connectivityStatus=OFFLINE (no packet for > 65 minutes).`);
      dispatchDeviceOfflineAdminEmails(candidates).catch((err) =>
        console.error('Error dispatching offline Admin email alerts:', err)
      );
    }
  } catch (err: any) {
    console.error('[DEVICE STATUS WORKER ERROR] Failed to sweep offline devices:', err?.message || err);
  }
}

/**
 * Starts the continuous telemetry poller and 65-minute offline status worker
 */
export function startTelemetryMonitor(intervalMs = 3000) {
  initTelemetryMonitor().then(() => {
    setInterval(pollTelemetryTransitions, intervalMs);
    // Immediate sweep upon startup + recurring every 60s
    checkAndMarkOfflineDevices();
    setInterval(checkAndMarkOfflineDevices, 60000);
  });
}
