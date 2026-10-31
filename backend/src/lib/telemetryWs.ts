import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { prisma } from './prisma';
import url from 'url';

interface ClientSubscription {
  ws: WebSocket;
  gateId?: number;
  isAlive: boolean;
}

const clients = new Set<ClientSubscription>();
let wss: WebSocketServer | null = null;

/**
 * Format duration in seconds to human readable string (e.g. "14m 22s", "2h 5m", "45s")
 */
export function formatDurationHuman(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return '—';
  if (seconds === 0) return '0s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

/**
 * Builds the comprehensive telemetry payload for a gate (mirrors GET /api/v1/lcgates/:id/telemetry)
 */
export async function getGateTelemetryPayload(gateId: number) {
  const gate = await prisma.lCGate.findUnique({
    where: { id: gateId },
    include: {
      masters: {
        orderBy: { masterSequence: 'asc' },
        include: { childDevices: { orderBy: { deviceSequence: 'asc' } } }
      },
      deviceRegistries: true,
    }
  });

  if (!gate) return null;

  // If gate has no Master Unit attached, it has NO live hardware telemetry!
  if (!gate.masters || gate.masters.length === 0) {
    return {
      success: true,
      gateId: gate.id,
      lcNumber: gate.lcNumber,
      locationName: gate.locationName,
      hasMaster: false,
      mastersCount: 0,
      thingName: null,
      deviceStatus: 'UNCONFIGURED',
      isDeviceOnline: false,
      lastSeenAt: null,
      currentStatus: 'UNCONFIGURED',
      currentOperationalState: {
        isCurrentlyOpen: false,
        currentStatus: 'UNCONFIGURED',
        rawReportedStatus: 'NO_MASTER',
        currentStateStartedAt: null,
        timeInCurrentStateSeconds: 0,
        timeInCurrentStateFormatted: '—',
        activeCycle: null,
        lastClosedCycle: null,
        totalCyclesRecorded: 0,
      },
      topic: null,
      counts: {
        all: 0,
        telemetry: 0,
        manifest: 0,
        healthCheck: 0,
        cycles: 0,
      },
      payloads: [],
      telemetryRecords: [],
      manifestRecords: [],
      healthRecords: [],
      operationalCycles: [],
      latestTelemetry: null,
      latestManifest: null,
      latestHealthCheck: null,
      timestamp: new Date().toISOString()
    };
  }

  // Only query telemetry for explicitly registered master hardware
  const masterSerials = gate.masters.map(m => m.serialNumber).filter(Boolean);
  const linkedRegistryThings = gate.deviceRegistries.filter(d => d.masterId !== null).map(d => d.thingName).filter(Boolean);
  const thingIdentifiers = Array.from(new Set([...masterSerials, ...linkedRegistryThings]));
  const deviceRegistryIds = gate.deviceRegistries.filter(d => d.masterId !== null).map(d => d.id);

  // Fetch real device telemetry, health checks, and operational cycles from database
  const [telemetries, healthChecks, rawEvents] = await Promise.all([
    prisma.deviceTelemetry.findMany({
      where: {
        OR: [
          { thingName: { in: thingIdentifiers } },
          ...(deviceRegistryIds.length > 0 ? [{ deviceRegistryId: { in: deviceRegistryIds } }] : [])
        ]
      },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    }).catch(() => []),
    prisma.deviceHealthCheck.findMany({
      where: {
        OR: [
          { thingName: { in: thingIdentifiers } },
          ...(deviceRegistryIds.length > 0 ? [{ deviceRegistryId: { in: deviceRegistryIds } }] : [])
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }).catch(() => []),
    prisma.lCGateEvent.findMany({
      where: { gateId },
      orderBy: { openedAt: 'desc' },
      take: 100,
    }).catch(() => [])
  ]);

  // Normalize any NOT_CLOSED payload to OPEN across the system
  telemetries.forEach(t => {
    if (t.payload && typeof t.payload === 'object') {
      const p = t.payload as any;
      if (p.Status === 'NOT_CLOSED') p.Status = 'OPEN';
      if (p.status === 'NOT_CLOSED') p.status = 'OPEN';
    }
    if (t.status === 'NOT_CLOSED') (t as any).status = 'OPEN';
  });

  const nowMs = Date.now();
  const operationalCycles = rawEvents.map(ev => {
    let duration = ev.durationSeconds;
    if (duration === null || duration === undefined) {
      if (ev.closedAt) {
        duration = Math.max(0, Math.round((new Date(ev.closedAt).getTime() - new Date(ev.openedAt).getTime()) / 1000));
      } else {
        duration = Math.max(0, Math.round((nowMs - new Date(ev.openedAt).getTime()) / 1000));
      }
    }
    return {
      id: ev.id,
      gateId: ev.gateId,
      openedAt: ev.openedAt.toISOString(),
      closedAt: ev.closedAt ? ev.closedAt.toISOString() : null,
      durationSeconds: duration,
      formattedDuration: ev.closedAt ? formatDurationHuman(duration) : `${formatDurationHuman(duration)} (In Progress)`,
      status: ev.status,
      openedBy: ev.openedBy,
      closedBy: ev.closedBy,
      trainNumber: ev.trainNumber,
      remarks: ev.remarks,
      createdAt: ev.createdAt.toISOString(),
    };
  });

  const activeOpenCycle = operationalCycles.find(c => c.status === 'OPEN' || !c.closedAt);
  const lastClosedCycle = operationalCycles.find(c => c.closedAt !== null);

  // Categorize payloads matching DeviceRegistry 1:1
  // 1. Telemetry: strictly gate state telemetry
  const telemetryRecords = telemetries.filter(t =>
    (t.topic && t.topic.includes('/telemetry')) &&
    !(t.topic && t.topic.includes('/health')) &&
    !((t.payload as any)?.action === 'HEALTH_CHECK' || (t.payload as any)?.action === 'HEALTH_CHECK_RESPONSE')
  );

  // 2. Manifest: firmware and hardware configurations
  const manifestRecords = telemetries.filter(t =>
    (t.topic && t.topic.includes('/manifest')) ||
    (t.payload && typeof t.payload === 'object' && ((t.payload as any).thing !== undefined || (t.payload as any).Master !== undefined))
  );

  // 3. Health Checks: dedicated health checks combined with legacy health payloads
  const healthRecords = healthChecks.length > 0 ? healthChecks.map((h: any) => ({
    id: h.id,
    thingName: h.thingName,
    topic: `lc-gate/${h.thingName}/health`,
    payload: h.rawPayload,
    status: h.healthstatus || 'HEALTHY',
    receivedAt: h.createdAt,
    deviceRegistryId: h.deviceRegistryId,
    gateStatus: h.gateStatus,
    isDedicatedHealthCheck: true,
  })) : telemetries.filter(t =>
    (t.topic && t.topic.includes('/health')) ||
    (t.payload && typeof t.payload === 'object' && ((t.payload as any).action === 'HEALTH_CHECK' || (t.payload as any).action === 'HEALTH_CHECK_RESPONSE' || (t.payload as any).healthstatus !== undefined))
  );

  // Unified deduplicated payloads
  const seenUids = new Set<string>();
  const deduplicatedPayloads: any[] = [];
  if (healthChecks.length > 0) {
    for (const h of healthRecords) {
      const uid = `hc-${h.id}`;
      if (!seenUids.has(uid)) {
        seenUids.add(uid);
        deduplicatedPayloads.push(h);
      }
    }
  }
  for (const t of telemetries) {
    const uid = `tel-${t.id}`;
    if (!seenUids.has(uid)) {
      seenUids.add(uid);
      deduplicatedPayloads.push(t);
    }
  }
  deduplicatedPayloads.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());

  const latestTele = telemetryRecords[0]?.payload as any;
  const rawStatus = latestTele?.Status ? String(latestTele.Status).trim().toUpperCase() : null;
  let resolvedGateState: 'OPEN' | 'CLOSED' = 'CLOSED';

  if (rawStatus === 'CLOSED') {
    resolvedGateState = 'CLOSED';
  } else if (rawStatus === 'OPEN' || rawStatus === 'NOT_CLOSED') {
    resolvedGateState = 'OPEN';
  } else if (latestTele?.LimitSwitchClosed !== undefined) {
    resolvedGateState = latestTele.LimitSwitchClosed ? 'CLOSED' : 'OPEN';
  } else if (activeOpenCycle) {
    resolvedGateState = 'OPEN';
  } else if (gate.deviceRegistries[0]?.status) {
    const devStatus = gate.deviceRegistries[0].status.toUpperCase();
    resolvedGateState = (devStatus === 'OPEN' || devStatus === 'NOT_CLOSED') ? 'OPEN' : 'CLOSED';
  }

  const isCurrentlyOpen = resolvedGateState === 'OPEN';
  const currentStatus = resolvedGateState;

  // Calculate duration in current state
  let timeInCurrentStateSeconds = 0;
  let currentStateStartedAt: string | null = null;
  if (isCurrentlyOpen) {
    currentStateStartedAt = activeOpenCycle?.openedAt || (telemetryRecords[0]?.receivedAt ? new Date(telemetryRecords[0].receivedAt).toISOString() : new Date().toISOString());
    timeInCurrentStateSeconds = Math.max(0, Math.round((nowMs - new Date(currentStateStartedAt).getTime()) / 1000));
  } else {
    // Current state is CLOSED
    currentStateStartedAt = lastClosedCycle?.closedAt || (telemetryRecords[0]?.receivedAt ? new Date(telemetryRecords[0].receivedAt).toISOString() : null);
    if (currentStateStartedAt) {
      timeInCurrentStateSeconds = Math.max(0, Math.round((nowMs - new Date(currentStateStartedAt).getTime()) / 1000));
    }
  }

  const currentOperationalState = {
    isCurrentlyOpen,
    currentStatus,
    rawReportedStatus: (latestTele?.Status === 'NOT_CLOSED' ? 'OPEN' : latestTele?.Status) || currentStatus,
    currentStateStartedAt,
    timeInCurrentStateSeconds,
    timeInCurrentStateFormatted: formatDurationHuman(timeInCurrentStateSeconds),
    activeCycle: isCurrentlyOpen ? (activeOpenCycle || null) : null,
    lastClosedCycle: lastClosedCycle || null,
    totalCyclesRecorded: operationalCycles.length,
  };

  const primaryThingName = gate.masters[0]?.serialNumber || 'Unassigned';

  // 65-Minute Rule: determine device connectivity (1 hr periodic heartbeat + 5 min grace)
  const ONLINE_CUTOFF_MS = 65 * 60 * 1000;
  const latestPacketTime = deduplicatedPayloads[0]?.receivedAt ? new Date(deduplicatedPayloads[0].receivedAt).getTime() : 0;
  const lastSeenTimes = [
    latestPacketTime,
    ...gate.deviceRegistries.map(d => d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0)
  ];
  const maxLastSeen = Math.max(...lastSeenTimes);
  const isDeviceOnline = maxLastSeen > 0 && (nowMs - maxLastSeen <= ONLINE_CUTOFF_MS);
  const deviceStatus: 'ONLINE' | 'OFFLINE' = isDeviceOnline ? 'ONLINE' : 'OFFLINE';

  return {
    success: true,
    gateId: gate.id,
    lcNumber: gate.lcNumber,
    locationName: gate.locationName,
    thingName: primaryThingName,
    deviceStatus,
    isDeviceOnline,
    lastSeenAt: maxLastSeen > 0 ? new Date(maxLastSeen).toISOString() : null,
    currentStatus,
    currentOperationalState,
    topic: `lc-gate/${primaryThingName}/telemetry`,
    counts: {
      all: deduplicatedPayloads.length,
      telemetry: telemetryRecords.length,
      manifest: manifestRecords.length,
      healthCheck: healthRecords.length,
      cycles: operationalCycles.length,
    },
    payloads: deduplicatedPayloads,
    telemetryRecords,
    manifestRecords,
    healthRecords,
    operationalCycles,
    latestTelemetry: telemetryRecords[0] || null,
    latestManifest: manifestRecords[0] || null,
    latestHealthCheck: healthRecords[0] || null,
    timestamp: new Date().toISOString()
  };
}

/**
 * Initializes the WebSocket server attached to the existing HTTP server
 */
export function initTelemetryWebSocket(server: HttpServer) {
  wss = new WebSocketServer({ server, path: '/ws/telemetry' });

  wss.on('connection', async (ws: WebSocket, req) => {
    const parsedUrl = url.parse(req.url || '', true);
    const gateIdParam = parsedUrl.query.gateId;
    const gateId = gateIdParam ? parseInt(gateIdParam.toString(), 10) : undefined;

    const sub: ClientSubscription = { ws, gateId, isAlive: true };
    clients.add(sub);
    console.log(`🔌 [WS TELEMETRY] Client connected${gateId ? ` for gate #${gateId}` : ''} (Total: ${clients.size})`);

    // Send confirmation and initial state immediately
    ws.send(JSON.stringify({
      type: 'connection_established',
      message: 'Connected to LC Platform live telemetry WebSocket stream',
      gateId,
    }));

    if (gateId && !isNaN(gateId)) {
      try {
        const payload = await getGateTelemetryPayload(gateId);
        if (payload && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'telemetry_init',
            gateId,
            data: payload
          }));
        }
      } catch (err) {
        console.error(`[WS TELEMETRY] Error fetching initial telemetry for #${gateId}:`, err);
      }
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          return;
        }

        if (msg.type === 'subscribe') {
          const newGateId = parseInt(msg.gateId, 10);
          if (!isNaN(newGateId)) {
            sub.gateId = newGateId;
            const payload = await getGateTelemetryPayload(newGateId);
            if (payload && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'telemetry_init',
                gateId: newGateId,
                data: payload
              }));
            }
          }
        }
      } catch (e) {
        // Ignore unparseable messages
      }
    });

    ws.on('pong', () => {
      sub.isAlive = true;
    });

    ws.on('close', () => {
      clients.delete(sub);
      console.log(`🔌 [WS TELEMETRY] Client disconnected (Remaining: ${clients.size})`);
    });

    ws.on('error', (err) => {
      console.warn(`[WS TELEMETRY] Client error:`, err.message);
      clients.delete(sub);
    });
  });

  // Heartbeat ping interval
  const pingInterval = setInterval(() => {
    for (const sub of clients) {
      if (!sub.isAlive) {
        sub.ws.terminate();
        clients.delete(sub);
        continue;
      }
      sub.isAlive = false;
      sub.ws.ping();
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  console.log(`📡 [WS TELEMETRY] WebSocket server ready on /ws/telemetry`);
}

/**
 * Broadcasts live telemetry updates to connected clients
 */
export async function broadcastGateTelemetry(gateId: number, customData?: any) {
  if (!wss || clients.size === 0) return;

  const dataToSend = customData || (await getGateTelemetryPayload(gateId));
  if (!dataToSend) return;

  const message = JSON.stringify({
    type: 'telemetry_update',
    gateId,
    data: dataToSend
  });

  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      // Send if client is viewing this gate or general listener
      if (!client.gateId || client.gateId === gateId) {
        client.ws.send(message);
      }
    }
  }
}

