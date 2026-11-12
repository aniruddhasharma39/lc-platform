/**
 * Local End-to-End Runner for AWS Lambda Handler
 * Covers: CREATED, UPDATED, DELETED, MANIFEST, HEALTH (including DEGRADED + strict coercions), and TELEMETRY.
 *
 * Uses an in-memory `pg` Pool stub by default (`USE_LIVE_DB !== 'true'`) so it runs safely anywhere
 * with `node test-local.js`; set `USE_LIVE_DB=true` and `DATABASE_URL=...` to exercise live RDS.
 */

const assert = require('assert');
const Module = require('module');

const useLiveDb = process.env.USE_LIVE_DB === 'true';
const sqlLog = [];
let existingDeviceRow = null;
let existingGateEvents = [];

if (!useLiveDb) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'pg') {
      return {
        Pool: function MockPool() {
          return {
            on() {},
            async connect() {
              return {
                async query(sql, params) {
                  const clean = sql.trim();
                  sqlLog.push({ sql: clean, params });

                  if (clean.includes('FROM "DeviceRegistry"') && clean.includes('FOR UPDATE')) {
                    return {
                      rowCount: existingDeviceRow ? 1 : 0,
                      rows: existingDeviceRow ? [existingDeviceRow] : [],
                    };
                  }
                  if (clean.includes('FROM "LCGateEvent"') && clean.includes('FOR UPDATE')) {
                    return { rowCount: existingGateEvents.length, rows: existingGateEvents };
                  }
                  if (clean.includes('INSERT INTO "AppSetting"') && params && String(params[0]).startsWith('REPORT_GATE_REV_')) {
                    return { rowCount: 1, rows: [{ rev: '12' }] };
                  }
                  if (clean.startsWith('INSERT INTO "DeviceRegistry"')) {
                    return {
                      rowCount: 1,
                      rows: [{
                        id: 401,
                        thingName: params[0],
                        serialNumber: params[4],
                        connectivityStatus: params[6],
                        barrierState: params[7],
                      }],
                    };
                  }
                  if (clean.startsWith('DELETE FROM "DeviceRegistry"')) {
                    return { rowCount: existingDeviceRow ? 1 : 0, rows: existingDeviceRow ? [existingDeviceRow] : [] };
                  }
                  if (clean.startsWith('INSERT INTO "DeviceTelemetry"')) {
                    return {
                      rowCount: 1,
                      rows: [{ id: 901, thingName: params[0], topic: params[1], status: params[3], receivedAt: params[5] }],
                    };
                  }
                  return { rowCount: 0, rows: [] };
                },
                release() {},
              };
            },
          };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://mock:mock@localhost:5432/mock';
}

const { handler, _helpers } = require('./index');

async function run() {
  console.log(`[test-local] Running AWS Lambda E2E suite (liveDb=${useLiveDb})...`);

  // Helper unit checks for P3 date & scalar coercion hardening
  assert.strictEqual(_helpers.parseFlexibleDate('05-15-2024'), null, 'Month 15 must return null, never overflow into 2025');
  assert.strictEqual(_helpers.parseFlexibleDate('31-02-2024'), null, 'Feb 31 must return null');
  assert.strictEqual(_helpers.parseFlexibleDate('15-05-2024'), '2024-05-15T00:00:00.000Z');
  assert.strictEqual(_helpers.toStrictBoolean('false'), false, 'String "false" must coerce to false');
  assert.strictEqual(_helpers.toStrictBoolean('true'), true);
  assert.strictEqual(_helpers.toFiniteFloat('abc'), null, 'Non-numeric float must return null, never NaN');
  assert.strictEqual(_helpers.toFiniteInt('not-int'), null, 'Non-numeric int must return null, never NaN');

  // 1. CREATED lifecycle event
  sqlLog.length = 0;
  existingDeviceRow = null;
  const createdRes = await handler({
    eventType: 'THING_EVENT',
    operation: 'CREATED',
    topic: '$aws/events/thing/LC-TEST-01/created',
    thingName: 'LC-TEST-01',
    thingTypeName: 'MasterUnit',
    attributes: { serialNumber: 'LC-TEST-01', hardwareVersion: 'rev2.1' },
  });
  assert.strictEqual(createdRes.statusCode, 200);
  if (!useLiveDb) {
    const up = sqlLog.find((q) => q.sql.startsWith('INSERT INTO "DeviceRegistry"'));
    assert.strictEqual(up.params[6], 'OFFLINE', 'CREATED keeps connectivityStatus=OFFLINE until MQTT live telemetry');
    const tel = sqlLog.find((q) => q.sql.startsWith('INSERT INTO "DeviceTelemetry"'));
    assert.strictEqual(tel.params[3], 'ACTIVE');
  }
  console.log('  [PASS] 1. CREATED lifecycle event');

  // 2. UPDATED lifecycle event
  sqlLog.length = 0;
  existingDeviceRow = { id: 401, thingName: 'LC-TEST-01', connectivityStatus: 'OFFLINE', lastSeenAt: null };
  const updatedRes = await handler({
    eventType: 'THING_EVENT',
    operation: 'UPDATED',
    topic: '$aws/events/thing/LC-TEST-01/updated',
    thingName: 'LC-TEST-01',
    attributes: { firmwareVersion: '1.3.0' },
  });
  assert.strictEqual(updatedRes.statusCode, 200);
  if (!useLiveDb) {
    const tel = sqlLog.find((q) => q.sql.startsWith('INSERT INTO "DeviceTelemetry"'));
    assert.strictEqual(tel.params[3], 'UPDATED');
    assert.strictEqual(sqlLog.find((q) => q.sql.startsWith('INSERT INTO "DeviceRegistry"')).params[24], false);
  }
  console.log('  [PASS] 2. UPDATED lifecycle event');

  // 3. MANIFEST firmware profile packet (modern device_manifest.c shape)
  sqlLog.length = 0;
  const manifestRes = await handler({
    topic: 'lc/devices/LC-TEST-01/manifest',
    thingName: 'LC-TEST-01',
    serialNumber: 'LC-TEST-01',
    hardware: { version: '2.2', macAddress: 'AA:BB:CC:DD:EE:01' },
    firmware: { version: '1.3.1' },
    manufacturing: { manufacturer: 'Mirtha', modelNumber: 'LC-GATE-MASTER-V2', dateOfMfg: '15-05-2024' },
    runtimeConfig: { heartbeatIntervalSec: 3600 },
    sensors: [{ name: 'Boom Angle', type: 'INCLINOMETER' }],
    components: [{ name: 'MCU', model: 'STM32F401' }],
  });
  assert.strictEqual(manifestRes.statusCode, 200);
  if (!useLiveDb) {
    const tel = sqlLog.find((q) => q.sql.startsWith('INSERT INTO "DeviceTelemetry"'));
    assert.strictEqual(tel.params[1], 'lc/devices/LC-TEST-01/manifest');
    assert.strictEqual(tel.params[3], 'MANIFEST');
    const up = sqlLog.find((q) => q.sql.startsWith('INSERT INTO "DeviceRegistry"'));
    assert.strictEqual(up.params[15], '2024-05-15T00:00:00.000Z');
  }
  console.log('  [PASS] 3. MANIFEST packet');

  // 4. HEALTH check (DEGRADED + string "false" + invalid NaN float guards)
  sqlLog.length = 0;
  const healthRes = await handler({
    topic: 'lc-gate/LC-TEST-01/health',
    thingName: 'LC-TEST-01',
    status: 'DEGRADED',
    Status: 'OPEN',
    BoomAngle: 'bad-float',
    BatteryVoltage: '11.1',
    SignalStrength: '4',
    LimitSwitchClosed: 'false',
    HallClosed: 'true',
    SolarCharging: '0',
    UptimeSeconds: 'abc',
  });
  assert.strictEqual(healthRes.statusCode, 200);
  if (!useLiveDb) {
    const hc = sqlLog.find((q) => q.sql.startsWith('INSERT INTO "DeviceHealthCheck"'));
    assert.strictEqual(hc.params[2], 'DEGRADED');
    assert.strictEqual(hc.params[3], 'OPEN');
    assert.strictEqual(hc.params[4], null, 'Invalid BoomAngle float must be null');
    assert.strictEqual(hc.params[8], false, 'String "false" LimitSwitchClosed must be false');
    assert.strictEqual(hc.params[9], true, 'String "true" HallClosed must be true');
    assert.strictEqual(hc.params[10], 11.1);
    assert.strictEqual(hc.params[13], false, '"0" SolarCharging must be false');
    assert.strictEqual(hc.params[14], null, 'Invalid UptimeSeconds int must be null');
  }
  console.log('  [PASS] 4. HEALTH diagnostic with strict coercions & DEGRADED verdict');

  // 5. TELEMETRY barrier packet & heartbeat packet
  sqlLog.length = 0;
  const teleBarrierRes = await handler({
    topic: 'lc-gate/LC-TEST-01/telemetry',
    thingName: 'LC-TEST-01',
    Status: 'CLOSED',
    timestamp: new Date().toISOString(),
  });
  assert.strictEqual(teleBarrierRes.statusCode, 200);
  if (!useLiveDb) {
    assert.strictEqual(sqlLog.find((q) => q.sql.startsWith('INSERT INTO "DeviceTelemetry"')).params[3], 'CLOSED');
  }

  sqlLog.length = 0;
  const teleHbRes = await handler({
    topic: 'lc-gate/LC-TEST-01/telemetry',
    thingName: 'LC-TEST-01',
    Status: 'ONLINE',
  });
  assert.strictEqual(teleHbRes.statusCode, 200);
  if (!useLiveDb) {
    assert.strictEqual(sqlLog.find((q) => q.sql.startsWith('INSERT INTO "DeviceTelemetry"')).params[3], 'HEARTBEAT');
  }
  console.log('  [PASS] 5. TELEMETRY barrier + heartbeat packets');

  // 6. DELETED lifecycle event (transactional cleanup)
  sqlLog.length = 0;
  existingDeviceRow = { id: 401, gateId: 9, masterId: 3 };
  existingGateEvents = [
    {
      id: 700,
      gateId: 9,
      masterId: 3,
      masterSerial: 'LC-TEST-01',
      thingName: 'LC-TEST-01',
      openedAt: new Date('2026-11-11T04:00:00Z'),
      closedAt: new Date('2026-11-11T04:05:00Z'),
      durationSeconds: 300,
      status: 'CLOSED',
      openedBy: null,
      closedBy: null,
      trainNumber: null,
      remarks: null,
    },
  ];
  const delRes = await handler({
    eventType: 'THING_EVENT',
    operation: 'DELETED',
    thingName: 'LC-TEST-01',
  });
  assert.strictEqual(delRes.statusCode, 200);
  if (!useLiveDb) {
    const body = JSON.parse(delRes.body);
    assert.strictEqual(body.cleanedEventsCount, 1);
    assert.ok(sqlLog.some((q) => q.sql.includes('INSERT INTO "LCGateEventTombstone"')));
    assert.ok(sqlLog.some((q) => q.sql.includes('INSERT INTO "LCGateEventChangeLog"')));
    assert.ok(sqlLog.some((q) => q.sql.startsWith('DELETE FROM "DeviceRegistry"')));
  }
  console.log('  [PASS] 6. DELETED lifecycle event + tombstone cleanup');

  console.log('ALL test-local.js CHECKS PASSED!');
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
