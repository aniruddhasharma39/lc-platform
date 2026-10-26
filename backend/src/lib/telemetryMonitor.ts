import { prisma } from './prisma';
import { checkAndDispatchGateStateAlert } from './gateAlertSms';

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
