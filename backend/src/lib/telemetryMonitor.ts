import { prisma } from './prisma';
import { checkAndDispatchGateStateAlert } from './gateAlertSms';
import { broadcastGateTelemetry } from './telemetryWs';

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
  thingName: string;
  newState: 'OPEN' | 'CLOSED';
  timestamp?: Date;
}) {
  try {
    const { gateId, thingName, newState } = params;
    const timestamp = params.timestamp || new Date();

    // 1. Resolve gate ID
    let targetGateId = gateId;
    if (!targetGateId) {
      // Find gate by thingName or serialNumber in DeviceRegistry
      const dev = await prisma.deviceRegistry.findFirst({
        where: {
          OR: [
            { thingName },
            { serialNumber: thingName }
          ]
        },
        select: { gateId: true }
      });
      if (dev?.gateId) {
        targetGateId = dev.gateId;
      } else {
        // Fallback: match by LC number
        const gate = await prisma.lCGate.findFirst({
          where: {
            OR: [
              { lcNumber: thingName },
              { name: thingName }
            ]
          },
          select: { id: true }
        });
        if (gate) targetGateId = gate.id;
      }
    }

    if (!targetGateId) {
      // No gate linked to this device yet
      return null;
    }

    if (newState === 'OPEN') {
      // Check if there is already an open event that hasn't closed yet
      const existingOpen = await prisma.lCGateEvent.findFirst({
        where: {
          gateId: targetGateId,
          status: 'OPEN',
          closedAt: null
        },
        orderBy: { openedAt: 'desc' }
      });

      if (!existingOpen) {
        const newEvent = await prisma.lCGateEvent.create({
          data: {
            gateId: targetGateId,
            openedAt: timestamp,
            status: 'OPEN',
            openedBy: `AWS IoT / ${thingName}`,
            remarks: `State transition: OPEN detected by IoT Telemetry`
          }
        });
        console.log(`📊 [REPORTS] Logged OPEN event #${newEvent.id} for Gate #${targetGateId} (${thingName})`);
        return newEvent;
      }
      return existingOpen;
    } else if (newState === 'CLOSED') {
      // Find latest OPEN event for this gate
      const openEvent = await prisma.lCGateEvent.findFirst({
        where: {
          gateId: targetGateId,
          status: 'OPEN',
          closedAt: null
        },
        orderBy: { openedAt: 'desc' }
      });

      if (openEvent) {
        const durationSeconds = Math.max(0, Math.round((timestamp.getTime() - openEvent.openedAt.getTime()) / 1000));
        const finalStatus = durationSeconds > 900 ? 'EXTENDED_DELAY' : 'CLOSED';

        const updated = await prisma.lCGateEvent.update({
          where: { id: openEvent.id },
          data: {
            closedAt: timestamp,
            durationSeconds,
            status: finalStatus,
            closedBy: `AWS IoT / ${thingName}`,
            remarks: openEvent.remarks ? `${openEvent.remarks} | Closed via IoT Telemetry` : `Closed via IoT Telemetry`
          }
        });
        console.log(`📊 [REPORTS] Updated CLOSED event #${updated.id} for Gate #${targetGateId} (${thingName}), duration: ${durationSeconds}s`);
        return updated;
      } else {
        // If OPEN event was missed (e.g. cold start), record a completed event with standard duration (e.g. 180s)
        const estimatedOpen = new Date(timestamp.getTime() - 180000);
        const newEvent = await prisma.lCGateEvent.create({
          data: {
            gateId: targetGateId,
            openedAt: estimatedOpen,
            closedAt: timestamp,
            durationSeconds: 180,
            status: 'CLOSED',
            openedBy: `AWS IoT / ${thingName}`,
            closedBy: `AWS IoT / ${thingName}`,
            remarks: `Direct CLOSED state detected via IoT Telemetry`
          }
        });
        console.log(`📊 [REPORTS] Created completed CLOSED event #${newEvent.id} for Gate #${targetGateId}`);
        return newEvent;
      }
    }
  } catch (err: any) {
    console.error('Error recording gate telemetry event for reports:', err?.message || err);
    return null;
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

        // Find device metadata
        const device = await prisma.deviceRegistry.findFirst({
          where: {
            OR: [
              { thingName },
              { id: record.deviceRegistryId || undefined }
            ]
          }
        });

        // Trigger SMS alert asynchronously
        checkAndDispatchGateStateAlert({
          deviceId: device?.id,
          gateId: device?.gateId,
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
 * Starts the continuous telemetry poller
 */
export function startTelemetryMonitor(intervalMs = 3000) {
  initTelemetryMonitor().then(() => {
    setInterval(pollTelemetryTransitions, intervalMs);
  });
}
