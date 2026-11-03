import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import deviceRoutes from '../src/routes/deviceRegistry';
import { errorHandler } from '../src/middleware/error';

async function runDeviceIsolationTests() {
  console.log('========================================================================');
  console.log('🔒 VERIFYING LC GATE DEVICE REGISTRY ISOLATION & DATA PRESERVATION');
  console.log('========================================================================\n');

  // 1. Verify user for authentication
  const user = await prisma.user.findFirst({
    where: { status: 'APPROVED' },
    include: { role: true },
  });

  if (!user) {
    throw new Error('No approved user found in database to generate JWT auth token.');
  }

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-jwt-key';
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role?.name || 'Developer' },
    jwtSecret,
    { expiresIn: '1h' }
  );

  // Setup express test server
  const app = express();
  app.use(express.json());
  app.use('/api/v1/devices', deviceRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const baseUrl = `http://localhost:${address.port}/api/v1/devices`;

  let passedAssertions = 0;
  let totalAssertions = 0;

  function assert(condition: boolean, message: string) {
    totalAssertions++;
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passedAssertions++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Confirm DB Row 1126 (SafeShunt device) exists in PostgreSQL
    // -------------------------------------------------------------------------
    console.log('TEST 1: Database Raw Record Verification');
    const row1126 = await prisma.deviceRegistry.findUnique({
      where: { id: 1126 },
    });
    assert(row1126 !== null, 'Row 1126 exists in the shared database.');
    assert(row1126?.thingName === 'SHN-NWR-JP-KWP-TX-19', 'Row 1126 thingName is "SHN-NWR-JP-KWP-TX-19".');
    console.log(`         Row 1126 is intact: ${row1126?.thingName} (${row1126?.deviceType})\n`);

    // -------------------------------------------------------------------------
    // TEST 2: GET /api/v1/devices (LC Platform Device List)
    // -------------------------------------------------------------------------
    console.log('TEST 2: GET /api/v1/devices scoping');
    const resList = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resList.status === 200, 'GET /api/v1/devices returns HTTP 200.');
    const dataList = await resList.json();
    assert(Array.isArray(dataList.devices), 'devices is an array.');

    // Ensure all returned devices strictly start with LC-
    for (const d of dataList.devices) {
      assert(
        d.thingName.toUpperCase().startsWith('LC-'),
        `Returned device "${d.thingName}" starts with "LC-" prefix.`
      );
      assert(
        d.id !== 1126 && d.thingName !== 'SHN-NWR-JP-KWP-TX-19',
        `SafeShunt device 1126 is excluded from device list.`
      );
    }
    console.log(`         Returned ${dataList.devices.length} LC- devices; SafeShunt excluded.\n`);

    // -------------------------------------------------------------------------
    // TEST 3: Search queries cannot bypass LC- prefix scoping
    // -------------------------------------------------------------------------
    console.log('TEST 3: Search scoping protection');
    const resSearch = await fetch(`${baseUrl}?search=SHN`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resSearch.status === 200, 'GET /api/v1/devices?search=SHN returns HTTP 200.');
    const dataSearch = await resSearch.json();
    assert(
      dataSearch.devices.length === 0,
      'Searching for "SHN" returns 0 devices (cannot bypass LC- barrier).'
    );
    console.log(`         Search "SHN" returned 0 devices.\n`);

    // -------------------------------------------------------------------------
    // TEST 4: Stats Summary counters
    // -------------------------------------------------------------------------
    console.log('TEST 4: GET /api/v1/devices/stats/summary counters');
    const resStats = await fetch(`${baseUrl}/stats/summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resStats.status === 200, 'GET /api/v1/devices/stats/summary returns HTTP 200.');
    const dataStats = await resStats.json();
    assert(typeof dataStats.total === 'number', 'dataStats.total is a number.');
    // Should strictly match count of LC- devices
    const dbLcCount = await prisma.deviceRegistry.count({
      where: {
        thingName: { startsWith: 'LC-', mode: 'insensitive' },
        deviceType: { not: 'SLAVE' },
      },
    });
    assert(
      dataStats.total === dbLcCount,
      `Summary total (${dataStats.total}) matches LC- count (${dbLcCount}) and excludes SafeShunt.`
    );
    console.log(`         Summary total count: ${dataStats.total} (excludes foreign devices)\n`);

    // -------------------------------------------------------------------------
    // TEST 5: Direct lookup for non-LC device returns 404
    // -------------------------------------------------------------------------
    console.log('TEST 5: Single device lookup scoping');
    const resGetId = await fetch(`${baseUrl}/1126`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resGetId.status === 404, 'GET /api/v1/devices/1126 returns HTTP 404.');

    const resGetName = await fetch(`${baseUrl}/SHN-NWR-JP-KWP-TX-19`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resGetName.status === 404, 'GET /api/v1/devices/SHN-NWR-JP-KWP-TX-19 returns HTTP 404.');

    const resGetTele = await fetch(`${baseUrl}/1126/telemetry`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resGetTele.status === 404, 'GET /api/v1/devices/1126/telemetry returns HTTP 404.\n');

    // -------------------------------------------------------------------------
    // TEST 6: Ingestion / Registration guards reject non-LC devices
    // -------------------------------------------------------------------------
    console.log('TEST 6: Registration & Ingestion API guards');
    // POST /api/v1/devices
    const resCreate = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        thingName: 'SHN-FORBIDDEN-TEST-01',
        deviceType: 'MASTER',
        status: 'ACTIVE',
      }),
    });
    assert(resCreate.status === 400, 'POST /api/v1/devices rejects non-LC thingName with HTTP 400.');

    // POST /api/v1/devices/manifest
    const resManifest = await fetch(`${baseUrl}/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thing: 'SHN-FORBIDDEN-MANIFEST-01',
        Master: { 'S.No.': 'SHN-FORBIDDEN-MANIFEST-01' },
      }),
    });
    assert(resManifest.status === 400, 'POST /api/v1/devices/manifest rejects non-LC thingName with HTTP 400.');

    // POST /api/v1/devices/telemetry (foreign telemetry ignored, not provisioned)
    const resTele = await fetch(`${baseUrl}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thingName: 'SHN-FOREIGN-TELE-01',
        Status: 'CLOSED',
      }),
    });
    assert(resTele.status === 200, 'POST /api/v1/devices/telemetry returns HTTP 200 without error.');
    const teleBody = await resTele.json();
    assert(
      teleBody.message && teleBody.message.includes('Foreign telemetry ignored'),
      'Foreign telemetry was safely ignored and not auto-provisioned.'
    );

    // Verify DB does not contain SHN-FOREIGN-TELE-01
    const foreignDev = await prisma.deviceRegistry.findFirst({
      where: { thingName: 'SHN-FOREIGN-TELE-01' },
    });
    assert(foreignDev === null, 'Foreign device was NOT created in DB.\n');

    // -------------------------------------------------------------------------
    // TEST 7: Attempting deletion on non-LC device fails with 404 (SafeShunt protected)
    // -------------------------------------------------------------------------
    console.log('TEST 7: Deletion safety check');
    const resDelete = await fetch(`${baseUrl}/1126`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resDelete.status === 404, 'DELETE /api/v1/devices/1126 returns HTTP 404.');

    // -------------------------------------------------------------------------
    // TEST 8: Final DB check - Row 1126 remains preserved and unaltered!
    // -------------------------------------------------------------------------
    console.log('TEST 8: SafeShunt Row 1126 Database Preservation Guarantee');
    const preservedRow1126 = await prisma.deviceRegistry.findUnique({
      where: { id: 1126 },
    });
    assert(preservedRow1126 !== null, 'Row 1126 is STILL present in database.');
    assert(preservedRow1126?.thingName === 'SHN-NWR-JP-KWP-TX-19', 'Row 1126 thingName is untouched.');
    assert(preservedRow1126?.deviceType === 'TRANSMITTER', 'Row 1126 deviceType is untouched.');
    console.log(`         Verified row 1126 is safe: ID ${preservedRow1126?.id}, ThingName ${preservedRow1126?.thingName}\n`);

    console.log('========================================================================');
    console.log(`🎉 ALL ${passedAssertions}/${totalAssertions} ISOLATION & PRESERVATION TESTS PASSED!`);
    console.log('========================================================================');
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

runDeviceIsolationTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

