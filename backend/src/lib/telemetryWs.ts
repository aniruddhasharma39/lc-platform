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

  const thingIdentifiers = Array.from(new Set([
    gate.lcNumber,
    ...gate.masters.map(m => m.serialNumber),
    ...gate.deviceRegistries.map(d => d.thingName),
    ...gate.deviceRegistries.map(d => d.serialNumber).filter(Boolean) as string[],
  ])).filter(Boolean);

  const deviceRegistryIds = gate.deviceRegistries.map(d => d.id);

  const telemetries = await prisma.deviceTelemetry.findMany({
    where: {
      OR: [
        { thingName: { in: thingIdentifiers } },
        ...(deviceRegistryIds.length > 0 ? [{ deviceRegistryId: { in: deviceRegistryIds } }] : [])
      ]
    },
    orderBy: { receivedAt: 'desc' },
    take: 100,
  }).catch(() => []);

  const telemetryRecords = telemetries.filter(t =>
    (t.topic && t.topic.includes('/telemetry')) ||
    (t.payload && typeof t.payload === 'object' && ((t.payload as any).Status !== undefined || (t.payload as any).LimitSwitchClosed !== undefined))
  );

  const manifestRecords = telemetries.filter(t =>
    (t.topic && t.topic.includes('/manifest')) ||
    (t.payload && typeof t.payload === 'object' && ((t.payload as any).thing !== undefined || (t.payload as any).Master !== undefined))
  );

  const healthRecords = telemetries.filter(t =>
    (t.topic && t.topic.includes('/health')) ||
    (t.payload && typeof t.payload === 'object' && ((t.payload as any).action === 'HEALTH_CHECK' || (t.payload as any).NetworkStrength !== undefined || (t.payload as any).BatteryPercentage !== undefined))
  );

  const latestTele = telemetryRecords[0]?.payload as any;
  const currentStatus = latestTele?.Status || (gate.deviceRegistries[0]?.status ?? 'CONFIGURED');
  const primaryThingName = gate.masters[0]?.serialNumber || gate.deviceRegistries[0]?.thingName || gate.lcNumber;

  return {
    success: true,
    gateId: gate.id,
    lcNumber: gate.lcNumber,
    locationName: gate.locationName,
    thingName: primaryThingName,
    currentStatus,
    topic: `lc-gate/${primaryThingName}/telemetry`,
    counts: {
      all: telemetries.length,
      telemetry: telemetryRecords.length,
      manifest: manifestRecords.length,
      healthCheck: healthRecords.length,
    },
    payloads: telemetries,
    telemetryRecords,
    manifestRecords,
    healthRecords,
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

