import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { prisma } from './prisma';
import url from 'url';
import {
  computeThingConnectivity,
  hydrateGateMasters,
  isGenuineTelemetryPacket,
  isManifestPacket,
  normalizeBarrierStateColumn,
  parseBarrierStateFromPayload,
  resolveGateStateFromThings,
} from './thingState';

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

const resolveStateFromPayload = parseBarrierStateFromPayload;

/**
 * Builds the comprehensive telemetry payload for a gate (mirrors GET /api/v1/lcgates/:id/telemetry)
 */
export async function getGateTelemetryPayload(gateId: number) {
  const rawGate = await prisma.lCGate.findUnique({
    where: { id: gateId },
    include: {
      masters: {
        orderBy: { masterSequence: 'asc' },
        include: { childDevices: { orderBy: { deviceSequence: 'asc' } }, deviceRegistry: true }
      },
      deviceRegistries: true,
    }
  });

  if (!rawGate) return null;
  const gate = hydrateGateMasters(rawGate as any);

  // If gate has no Master Unit attached, it has NO live hardware telemetry and NO operational cycles
  if (!gate.masters || gate.masters.length === 0) {
    return {
      success: true,
      gateId: gate.id,
      lcNumber: gate.lcNumber,
      locationName: gate.locationName,
      hasMaster: false,
      mastersCount: 0,
      onlineMastersCount: 0,
      hardwareMastersCount: 0,
      masterSummaries: [],
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

  // Strictly match each Master Unit to its 1-to-1 assigned DeviceRegistry row
  const masterThingBindings = gate.masters.map((m: any) => {
    const linkedReg =
      m.deviceRegistry ||
      (m.deviceRegistries && m.deviceRegistries[0]) ||
      gate.deviceRegistries.find((d: any) => d.masterId === m.id) ||
      null;
    return {
      master: m,
      reg: linkedReg,
      thingName: linkedReg?.thingName || null,
      registryId: linkedReg?.id || null,
      hasHardware: Boolean(linkedReg),
    };
  });

  const perThingQueryKeys = new Map<string, { thingName: string; registryId?: number | null }>();
  for (const b of masterThingBindings) {
    if (b.thingName) {
      perThingQueryKeys.set(b.thingName, { thingName: b.thingName, registryId: b.registryId });
    }
  }

  // Fetch inbound telemetry & health checks PER THING (excluding synthetic /health/request ping commands)
  const queryTargets = Array.from(perThingQueryKeys.values());
  const [telePerThing, hcPerThing, rawEvents] = await Promise.all([
    Promise.all(
      queryTargets.map(target =>
        prisma.deviceTelemetry.findMany({
          where: {
            OR: [
              { thingName: target.thingName },
              ...(target.registryId ? [{ deviceRegistryId: target.registryId }] : [])
            ],
            NOT: [{ topic: { contains: '/request' } }],
            status: { not: 'REQUESTED' },
          },
          orderBy: { receivedAt: 'desc' },
          take: 50,
        }).catch(() => [])
      )
    ),
    Promise.all(
      queryTargets.map(target =>
        prisma.deviceHealthCheck.findMany({
          where: {
            OR: [
              { thingName: target.thingName },
              ...(target.registryId ? [{ deviceRegistryId: target.registryId }] : [])
            ]
          },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }).catch(() => [])
      )
    ),
    prisma.lCGateEvent.findMany({
      where: { gateId },
      orderBy: { openedAt: 'desc' },
      take: 150,
    }).catch(() => [])
  ]);

  const teleMap = new Map<number, any>();
  for (const list of telePerThing) {
    for (const t of list) teleMap.set(t.id, t);
  }
  const telemetries = Array.from(teleMap.values()).sort(
    (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  );

  const hcMap = new Map<number, any>();
  for (const list of hcPerThing) {
    for (const h of list) hcMap.set(h.id, h);
  }
  const healthChecks = Array.from(hcMap.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

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
      masterId: ev.masterId || null,
      masterSerial: ev.masterSerial || null,
      thingName: ev.thingName || null,
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
  const telemetryRecords = telemetries.filter(isGenuineTelemetryPacket);
  const manifestRecords = telemetries.filter(isManifestPacket);

  const healthRecords = healthChecks.length > 0 ? healthChecks.map((h: any) => ({
    id: h.id,
    thingName: h.thingName,
    topic: `lc-gate/${h.thingName}/health`,
    payload: h.rawPayload,
    status: h.healthstatus || null,
    receivedAt: h.createdAt,
    deviceRegistryId: h.deviceRegistryId,
    gateStatus: h.gateStatus,
    isDedicatedHealthCheck: true,
  })) : telemetries.filter(t =>
    ((t.topic && t.topic.includes('/health') && !t.topic.includes('/request')) ||
    (t.payload && typeof t.payload === 'object' && ((t.payload as any).action === 'HEALTH_CHECK_RESPONSE' || (t.payload as any).healthstatus !== undefined)))
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

  // Compute independent per-Master state & connectivity strictly from DeviceRegistry DB truth
  const masterSummaries = masterThingBindings.map((b: any) => {
    const m = b.master;
    const reg = b.reg;
    const tName = b.thingName;
    const matchRec = (r: any) =>
      (tName && r.thingName === tName) ||
      (b.registryId && r.deviceRegistryId === b.registryId);

    const mTele = b.hasHardware ? telemetryRecords.filter(matchRec) : [];
    const mMan = b.hasHardware ? manifestRecords.filter(matchRec) : [];
    const mHealth = b.hasHardware ? healthRecords.filter(matchRec) : [];
    const mPayloads = b.hasHardware ? deduplicatedPayloads.filter(matchRec) : [];

    const conn = reg ? computeThingConnectivity(reg, nowMs) : { isOnline: false, connectivityStatus: 'OFFLINE' as const, lastSeenAt: null };
    const latestPacketTime = mPayloads[0]?.receivedAt ? new Date(mPayloads[0].receivedAt).getTime() : 0;
    const resolvedSeenMs = Math.max(latestPacketTime, conn.lastSeenAt ? new Date(conn.lastSeenAt).getTime() : 0);
    const isMasterOnline = b.hasHardware && conn.isOnline;
    const masterDeviceStatus: 'ONLINE' | 'OFFLINE' | 'VIRTUAL' = b.hasHardware
      ? (isMasterOnline ? 'ONLINE' : 'OFFLINE')
      : 'VIRTUAL';

    // Single source of truth: DB barrierState from real AWS IoT /telemetry (NEVER guess CLOSED or read LCGateEvent/reg.status)
    const dbBarrierState = b.hasHardware && reg ? normalizeBarrierStateColumn(reg.barrierState) : null;
    const mState: 'OPEN' | 'CLOSED' | 'NO_TELEMETRY' | 'UNCONFIGURED' = !b.hasHardware
      ? 'UNCONFIGURED'
      : (dbBarrierState || 'NO_TELEMETRY');

    return {
      masterId: m.id,
      masterSequence: m.masterSequence,
      serialNumber: m.serialNumber,
      powerSource: m.powerSource,
      hasHardware: b.hasHardware,
      thingName: tName,
      deviceRegistryId: b.registryId,
      deviceStatus: masterDeviceStatus,
      isDeviceOnline: isMasterOnline,
      lastSeenAt: resolvedSeenMs > 0 ? new Date(resolvedSeenMs).toISOString() : null,
      barrierState: dbBarrierState,
      currentStatus: mState,
      latestTelemetry: mTele[0] || null,
      latestManifest: mMan[0] || null,
      latestHealthCheck: mHealth[0] || null,
    };
  });

  const resolvedGate = resolveGateStateFromThings(gate, nowMs);
  const hardwareMasterSummaries = masterSummaries.filter((ms: any) => ms.hasHardware);
  const hardwareMastersCount = resolvedGate.hardwareMastersCount;
  const onlineMastersCount = resolvedGate.onlineMastersCount;
  const hasHardware = resolvedGate.hasHardware;
  const resolvedGateState = resolvedGate.status;

  const isCurrentlyOpen = resolvedGateState === 'OPEN';
  const currentStatus = resolvedGateState;

  // Pick representative telemetry for rawReportedStatus (prefer an OPEN master when gate is OPEN)
  const primaryDisplayMaster = isCurrentlyOpen
    ? (hardwareMasterSummaries.find((ms: any) => ms.currentStatus === 'OPEN') || hardwareMasterSummaries[0])
    : (hardwareMasterSummaries.find((ms: any) => ms.currentStatus === 'CLOSED') || hardwareMasterSummaries[0]);
  const latestTele = (primaryDisplayMaster?.latestTelemetry?.payload || telemetryRecords[0]?.payload) as any;

  // Calculate duration in current state (only when barrierState is actually known from AWS IoT)
  let timeInCurrentStateSeconds = 0;
  let currentStateStartedAt: string | null = null;
  if (isCurrentlyOpen) {
    currentStateStartedAt = activeOpenCycle?.openedAt || (telemetryRecords[0]?.receivedAt ? new Date(telemetryRecords[0].receivedAt).toISOString() : null);
    if (currentStateStartedAt) {
      timeInCurrentStateSeconds = Math.max(0, Math.round((nowMs - new Date(currentStateStartedAt).getTime()) / 1000));
    }
  } else if (resolvedGateState === 'CLOSED') {
    currentStateStartedAt = lastClosedCycle?.closedAt || (telemetryRecords[0]?.receivedAt ? new Date(telemetryRecords[0].receivedAt).toISOString() : null);
    if (currentStateStartedAt) {
      timeInCurrentStateSeconds = Math.max(0, Math.round((nowMs - new Date(currentStateStartedAt).getTime()) / 1000));
    }
  }

  const currentOperationalState = {
    isCurrentlyOpen,
    currentStatus,
    rawReportedStatus: resolveStateFromPayload(latestTele) || currentStatus,
    currentStateStartedAt,
    timeInCurrentStateSeconds,
    timeInCurrentStateFormatted: currentStateStartedAt ? formatDurationHuman(timeInCurrentStateSeconds) : '—',
    activeCycle: isCurrentlyOpen ? (activeOpenCycle || null) : null,
    lastClosedCycle: lastClosedCycle || null,
    totalCyclesRecorded: operationalCycles.length,
  };

  const primaryThingName = primaryDisplayMaster?.thingName || null;

  // Aggregate connectivity strictly from resolvedGate
  const latestPacketTime = deduplicatedPayloads[0]?.receivedAt ? new Date(deduplicatedPayloads[0].receivedAt).getTime() : 0;
  const resolvedLastSeen = resolvedGate.lastSeenAt || (latestPacketTime > 0 ? new Date(latestPacketTime).toISOString() : null);
  const isDeviceOnline = resolvedGate.isOnline;
  const deviceStatus = resolvedGate.deviceStatus;

  return {
    success: true,
    gateId: gate.id,
    lcNumber: gate.lcNumber,
    locationName: gate.locationName,
    hasMaster: resolvedGate.hasMaster,
    isConfigured: resolvedGate.isConfigured,
    mastersCount: gate.masters.length,
    onlineMastersCount,
    hardwareMastersCount,
    masterSummaries,
    thingName: primaryThingName,
    deviceStatus,
    isDeviceOnline,
    lastSeenAt: resolvedLastSeen,
    currentStatus,
    currentOperationalState,
    topic: primaryThingName ? `lc-gate/${primaryThingName}/telemetry` : null,
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
    latestTelemetry: primaryDisplayMaster?.latestTelemetry || telemetryRecords[0] || null,
    latestManifest: primaryDisplayMaster?.latestManifest || manifestRecords[0] || null,
    latestHealthCheck: primaryDisplayMaster?.latestHealthCheck || healthRecords[0] || null,
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

