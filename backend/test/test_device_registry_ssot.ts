import assert from 'assert';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import {
  classifyTelemetryPacketType,
  computeThingConnectivity,
  GATE_ONLINE_CUTOFF_MS,
  getOnlineCutoffDate,
  isGenuineTelemetryPacket,
  normalizeTelemetryPayloadForDisplay,
  normalizeTelemetryRecordForDisplay,
  resolveAuthoritativeBarrierState,
} from '../src/lib/thingState';
import deviceRoutes from '../src/routes/deviceRegistry';
import { errorHandler } from '../src/middleware/error';

async function runTests() {
  console.log('=== Verifying Device Registry DB SSoT Status & Telemetry ===');

  // 1. Unit checks for SSoT helpers
  const nowMs = Date.UTC(2026, 10, 11, 9, 30, 0);
  const cutoff = getOnlineCutoffDate(nowMs);
  assert.strictEqual(nowMs - cutoff.getTime(), GATE_ONLINE_CUTOFF_MS, 'Cutoff window equals 65 minutes');

  assert.strictEqual(
    isGenuineTelemetryPacket({
      topic: 'lc-gate/LC-M-001/telemetry',
      status: 'ONLINE',
      payload: { Status: 'ONLINE', thingName: 'LC-M-001', firmwareVersion: '1.0.8' },
    }),
    false,
    'Heartbeat-only Status=ONLINE packet on /telemetry must not be treated as genuine barrier telemetry'
  );

  assert.strictEqual(
    isGenuineTelemetryPacket({
      topic: 'lc-gate/LC-47E/telemetry',
      status: 'OPEN',
      payload: { Status: 'NOT_CLOSED', LimitSwitchClosed: false },
    }),
    true,
    'NOT_CLOSED / LimitSwitchClosed packet on /telemetry is genuine barrier telemetry'
  );

  assert.strictEqual(
    classifyTelemetryPacketType({
      topic: 'lc-gate/LC-M-001/telemetry',
      status: 'ONLINE',
      payload: { Status: 'ONLINE', thingName: 'LC-M-001', firmwareVersion: '1.0.8' },
    }),
    'HEARTBEAT',
    'Heartbeat-only packet classifies as HEARTBEAT'
  );

  assert.strictEqual(
    classifyTelemetryPacketType({
      topic: 'lc-gate/LC-M-001/telemetry',
      status: 'CLOSED',
      payload: { Status: 'CLOSED', LimitSwitchClosed: true },
    }),
    'TELEMETRY',
    'Physical CLOSED packet classifies as TELEMETRY'
  );

  assert.strictEqual(
    computeThingConnectivity(
      { status: 'ACTIVE', connectivityStatus: 'ONLINE', lastSeenAt: new Date(nowMs - 66 * 60 * 1000) },
      nowMs
    ).connectivityStatus,
    'OFFLINE',
    'Device silent for 66m resolves OFFLINE even if DB connectivityStatus column has not been swept yet'
  );

  assert.strictEqual(
    computeThingConnectivity(
      { status: 'INACTIVE', connectivityStatus: 'ONLINE', lastSeenAt: new Date(nowMs - 1000) },
      nowMs
    ).connectivityStatus,
    'OFFLINE',
    'INACTIVE lifecycle device stays OFFLINE regardless of lastSeenAt'
  );

  assert.strictEqual(
    computeThingConnectivity(
      { status: 'ACTIVE', connectivityStatus: 'OFFLINE', lastSeenAt: new Date(nowMs - 63 * 60 * 1000) },
      nowMs
    ).connectivityStatus,
    'ONLINE',
    'ACTIVE device with packet 63m ago resolves ONLINE within 65m window'
  );

  const originalRawPayload = { Status: 'NOT_CLOSED', LimitSwitchClosed: false, DeviceStatus: 'ONLINE' };
  const normalizedPayload = normalizeTelemetryPayloadForDisplay(originalRawPayload);
  assert.strictEqual(normalizedPayload.Status, 'OPEN', 'Display normalization converts NOT_CLOSED to OPEN');
  assert.strictEqual(originalRawPayload.Status, 'NOT_CLOSED', 'Display normalization does not mutate source object');

  const normalizedRecord = normalizeTelemetryRecordForDisplay({
    id: 500,
    status: 'NOT_CLOSED',
    payload: originalRawPayload,
  });
  assert.strictEqual(normalizedRecord.status, 'OPEN');
  assert.strictEqual(normalizedRecord.resolvedBarrierState, 'OPEN');

  assert.strictEqual(
    resolveAuthoritativeBarrierState(
      { barrierState: 'CLOSED', lastTelemetryAt: new Date(nowMs - 5000), lastTelemetryId: 10 },
      { id: 11, receivedAt: new Date(nowMs), payload: { Status: 'NOT_CLOSED', LimitSwitchClosed: false } }
    ),
    'OPEN',
    'Newer genuine telemetry packet overrides stale DeviceRegistry.barrierState immediately without waiting 3s worker'
  );

  assert.strictEqual(
    resolveAuthoritativeBarrierState(
      { barrierState: 'OPEN', lastTelemetryAt: new Date(nowMs), lastTelemetryId: 12 },
      { id: 12, receivedAt: new Date(nowMs), payload: { Status: 'NOT_CLOSED', LimitSwitchClosed: false } }
    ),
    'OPEN',
    'Same id/timestamp stays consistent with DeviceRegistry.barrierState'
  );

  // 2. Read-only HTTP API assertions against Express router & RDS
  const user = await prisma.user.findFirst({
    where: { status: 'APPROVED' },
    include: { role: true },
  });
  assert(user !== null, 'Approved user exists for JWT signing');

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role?.name || 'Developer' },
    process.env.JWT_SECRET || 'super-secret-jwt-key',
    { expiresIn: '1h' }
  );

  const app = express();
  app.use(express.json());
  app.use('/api/v1/devices', deviceRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://localhost:${port}/api/v1/devices`;

  try {
    const [listRes, statsRes, onlineRes, offlineRes] = await Promise.all([
      fetch(baseUrl, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${baseUrl}/stats/summary`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${baseUrl}?status=ONLINE`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${baseUrl}?status=OFFLINE`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);

    assert.strictEqual(listRes.status, 200, 'GET /api/v1/devices HTTP 200');
    assert.strictEqual(statsRes.status, 200, 'GET /api/v1/devices/stats/summary HTTP 200');
    assert.strictEqual(onlineRes.status, 200, 'GET /api/v1/devices?status=ONLINE HTTP 200');
    assert.strictEqual(offlineRes.status, 200, 'GET /api/v1/devices?status=OFFLINE HTTP 200');

    const listData: any = await listRes.json();
    const statsData: any = await statsRes.json();
    const onlineData: any = await onlineRes.json();
    const offlineData: any = await offlineRes.json();

    assert(listData.summary && typeof listData.summary === 'object', 'GET /api/v1/devices returns authoritative summary');
    assert.strictEqual(listData.summary.total, statsData.total, 'list summary.total matches /stats/summary');
    assert.strictEqual(listData.summary.online, statsData.onlineCount, 'list summary.online matches /stats/summary onlineCount');
    assert.strictEqual(
      listData.summary.online + listData.summary.offline,
      listData.summary.total,
      'online + offline equals total'
    );
    assert.strictEqual(onlineData.devices.length, listData.summary.online, 'status=ONLINE filter length equals summary.online');
    assert.strictEqual(offlineData.devices.length, listData.summary.offline, 'status=OFFLINE filter length equals summary.offline');
    assert(
      listData.devices.every((d: any) => String(d.thingName).toUpperCase().startsWith('LC-')),
      'All returned devices stay scoped to LC- prefix'
    );

    // Check LC-M-001 inspect endpoint specifically
    const lcm001 = listData.devices.find((d: any) => d.thingName === 'LC-M-001');
    if (lcm001) {
      const teleRes = await fetch(`${baseUrl}/${lcm001.id}/telemetry`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(teleRes.status, 200, 'GET /devices/:id/telemetry HTTP 200 for LC-M-001');
      const teleData: any = await teleRes.json();

      if (teleData.latestTelemetry) {
        assert(
          isGenuineTelemetryPacket(teleData.latestTelemetry),
          'LC-M-001 latestTelemetry is strictly genuine barrier telemetry (not heartbeat-only Status=ONLINE)'
        );
      }

      const heartbeatRows = (teleData.payloads || []).filter((p: any) => p.packetType === 'HEARTBEAT');
      assert(heartbeatRows.length > 0, 'Legacy Status=ONLINE rows remain preserved in payloads as HEARTBEAT');
      assert.strictEqual(
        heartbeatRows.every((p: any) => Boolean(p.receivedAt)),
        true,
        'Every heartbeat payload carries receivedAt timestamp'
      );
      assert.strictEqual(
        teleData.connectivityStatus,
        lcm001.connectivityStatus,
        'Detail endpoint connectivityStatus matches list endpoint'
      );
    }

    // Verify live Lambda-ingested device (e.g. LC-0007) normalizes NOT_CLOSED -> OPEN and aligns barrierState
    const lc0007 = listData.devices.find((d: any) => d.thingName === 'LC-0007');
    if (lc0007) {
      const teleRes = await fetch(`${baseUrl}/${lc0007.id}/telemetry`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(teleRes.status, 200, 'GET /devices/:id/telemetry HTTP 200 for LC-0007');
      const teleData: any = await teleRes.json();
      if (teleData.latestTelemetry) {
        assert.notStrictEqual(
          teleData.latestTelemetry?.payload?.Status,
          'NOT_CLOSED',
          'Normalized payload Status never exposes raw NOT_CLOSED contradiction'
        );
        if (teleData.latestTelemetry.resolvedBarrierState) {
          assert.strictEqual(
            teleData.currentStatus,
            teleData.latestTelemetry.resolvedBarrierState,
            'Header currentStatus strictly matches latestTelemetry.resolvedBarrierState'
          );
        }
      }
    }

    console.log('ALL BACKEND SSOT DEVICE REGISTRY TESTS PASSED!');
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

runTests().catch((err) => {
  console.error('Backend SSoT test failed:', err);
  process.exit(1);
});

