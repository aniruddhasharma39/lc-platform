import { prisma } from './prisma';
import { checkAndDispatchGateStateAlert } from './gateAlertSms';
import { broadcastGateTelemetry } from './telemetryWs';
import { bumpReportRevisionInTx, recordEventChangeInTx } from './reportRevisionManager';

let lastProcessedId = 0;
const lastKnownState = new Map<string, 'OPEN' | 'CLOSED'>();
let isPolling = false;

/**
 * Parses state ('OPEN' | 'CLOSED' | null) from a telemetry payload
 */
export function parseGateStateFromPayload(payload: any): 'OPEN' | 'CLOSED' | null {
  if (!payload || typeof payload !== 'object') return null;

  if (payload.Status !== undefined) {
    const s = String(payload.Status).trim().toUpperCase();
    if (s === 'CLOSED') return 'CLOSED';
    if (s === 'OPEN' || s === 'NOT_CLOSED') return 'OPEN';
  }

  if (payload.LimitSwitchClosed !== undefined) {
    return payload.LimitSwitchClosed ? 'CLOSED' : 'OPEN';
  }

  if (payload.status !== undefined) {
    const s = String(payload.status).trim().toUpperCase();
    if (s === 'CLOSED') return 'CLOSED';
    if (s === 'OPEN' || s === 'NOT_CLOSED') return 'OPEN';
  }

  return null;
}

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
      const foundDev = await prisma.deviceRegistry.findFirst({
        where: {
          OR: [
            { thingName },
            { serialNumber: thingName }
          ]
        },
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
        // If OPEN event was missed (e.g. cold start), record a completed event with standard duration (e.g. 180s)
        const estimatedOpen = new Date(timestamp.getTime() - 180000);
        return await prisma.$transaction(async (tx) => {
          const newEvent = await tx.lCGateEvent.create({
            data: {
              gateId: targetGateId!,
              masterId: targetMasterId,
              masterSerial: targetMasterSerial,
              thingName,
              openedAt: estimatedOpen,
              closedAt: timestamp,
              durationSeconds: 180,
              status: 'CLOSED',
              openedBy: 'Automated',
              closedBy: 'Automated',
              remarks: targetMasterSerial
                ? `Direct CLOSED state detected (${targetMasterSerial})`
                : `Direct CLOSED state detected via IoT Telemetry`
            }
          });
          await recordEventChangeInTx(tx, newEvent, 'INSERT');
          console.log(`📊 [REPORTS] Created completed CLOSED event #${newEvent.id} for Gate #${targetGateId} / Master ${targetMasterSerial || thingName}`);
          return newEvent;
        });
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

      const records = await prisma.deviceTelemetry.findMany({
        where: {
          OR: [
            { thingName: dev.thingName },
            { deviceRegistryId: dev.id },
            { topic: { contains: dev.thingName } }
          ]
        },
        orderBy: { receivedAt: 'asc' }
      });

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
            } else {
              // Started in closed state or cold start
              const estOpen = new Date(timestamp.getTime() - 180000);
              await prisma.$transaction(async (tx) => {
                const ev = await tx.lCGateEvent.create({
                  data: {
                    gateId: dev.gateId!,
                    masterId: dev.masterId,
                    masterSerial,
                    thingName: dev.thingName,
                    openedAt: estOpen,
                    closedAt: timestamp,
                    durationSeconds: 180,
                    status: 'CLOSED',
                    openedBy: 'Automated',
                    closedBy: 'Automated',
                    remarks: masterSerial
                      ? `Direct CLOSED state detected (${masterSerial})`
                      : `Direct CLOSED state detected via IoT Telemetry`
                  }
                });
                await recordEventChangeInTx(tx, ev, 'INSERT');
              });
              totalSynced++;
            }
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

    // Seed latest known states for all registered devices
    const devices = await prisma.deviceRegistry.findMany({
      select: { id: true, thingName: true }
    });

    for (const d of devices) {
      const lastTele = await prisma.deviceTelemetry.findFirst({
        where: {
          OR: [
            { deviceRegistryId: d.id },
            { thingName: d.thingName }
          ]
        },
        orderBy: { receivedAt: 'desc' }
      });

      if (lastTele?.payload) {
        const state = parseGateStateFromPayload(lastTele.payload);
        if (state) {
          lastKnownState.set(d.thingName, state);
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

      const currentState = parseGateStateFromPayload(record.payload);
      if (!currentState) continue;

      const prevState = lastKnownState.get(thingName);

      // Transition detected! (e.g., OPEN ➔ CLOSED or CLOSED ➔ OPEN)
      if (prevState && prevState !== currentState) {
        console.log(`⚡ [TELEMETRY MONITOR] State transition detected for "${thingName}": ${prevState} ➔ ${currentState}`);

        // Find device metadata with linked master
        const device = await prisma.deviceRegistry.findFirst({
          where: {
            OR: [
              { thingName },
              { id: record.deviceRegistryId || undefined }
            ]
          },
          include: {
            master: { select: { id: true, serialNumber: true } }
          }
        });

        // Trigger SMS alert asynchronously
        checkAndDispatchGateStateAlert({
          deviceId: device?.id,
          gateId: device?.gateId,
          masterId: device?.masterId,
          masterSerial: device?.master?.serialNumber || null,
          thingName,
          serialNumber: device?.serialNumber || thingName,
          newState: currentState,
          timestamp: record.receivedAt || new Date(),
        }).catch(err => console.error('Error dispatching SMS from telemetry monitor:', err));

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
  const OFFLINE_CUTOFF_MS = 65 * 60 * 1000; // 65 minutes
  const cutoffDate = new Date(Date.now() - OFFLINE_CUTOFF_MS);

  try {
    const result = await prisma.deviceRegistry.updateMany({
      where: {
        AND: [
          { status: { in: ['ONLINE', 'ACTIVE'] } },
          {
            OR: [
              { lastSeenAt: { lt: cutoffDate } },
              { lastSeenAt: null }
            ]
          }
        ]
      },
      data: {
        status: 'OFFLINE'
      }
    });

    if (result.count > 0) {
      console.log(`📡 [DEVICE STATUS WORKER] Marked ${result.count} devices as OFFLINE (no packet for > 65 minutes).`);
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
