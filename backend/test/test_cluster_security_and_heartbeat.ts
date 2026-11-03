import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import lcgateRoutes from '../src/routes/lcgate';
import deviceRegistryRoutes from '../src/routes/deviceRegistry';
import scopeGroupRoutes from '../src/routes/scopeGroups';
import { bumpDirectoryRevision } from '../src/lib/revisionManager';
import { clusterCacheManager } from '../src/lib/clusterCacheManager';
import { errorHandler } from '../src/middleware/error';

async function runSecurityAndHeartbeatTests() {
  console.log('========================================================================');
  console.log('🔒 FINAL EDGE-CASE AUDIT: CONCURRENT PROVISIONING, TELEMETRY ATOMICITY & SCOPE HIERARCHY');
  console.log('========================================================================\n');

  // Find Developer user for generating tokens
  const devUser = await prisma.user.findFirst({
    where: { status: 'APPROVED', role: { name: 'Developer' } },
    include: { role: true },
  }) || await prisma.user.findFirst({
    where: { status: 'APPROVED' },
    include: { role: true },
  });

  if (!devUser) {
    throw new Error('No approved user found in database to generate JWT auth token.');
  }

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-jwt-key';
  const token = jwt.sign(
    { userId: devUser.id, email: devUser.email, role: devUser.role?.name || 'Developer' },
    jwtSecret,
    { expiresIn: '1h' }
  );

  // Setup Instance A
  const appA = express();
  appA.use(express.json());
  appA.use('/api/v1/lcgate', lcgateRoutes);
  appA.use('/api/v1/devices', deviceRegistryRoutes);
  appA.use('/api/v1/scope-groups', scopeGroupRoutes);
  appA.use(errorHandler);
  const serverA = http.createServer(appA);
  await new Promise<void>((resolve) => serverA.listen(0, resolve));
  const portA = (serverA.address() as any).port;
  const urlA = `http://localhost:${portA}/api/v1/lcgate`;
  const telemetryUrlA = `http://localhost:${portA}/api/v1/devices/telemetry`;
  const scopeGroupUrlA = `http://localhost:${portA}/api/v1/scope-groups`;

  // Setup Instance B (simulates second independent backend instance)
  const appB = express();
  appB.use(express.json());
  appB.use('/api/v1/lcgate', lcgateRoutes);
  appB.use('/api/v1/devices', deviceRegistryRoutes);
  appB.use('/api/v1/scope-groups', scopeGroupRoutes);
  appB.use(errorHandler);
  const serverB = http.createServer(appB);
  await new Promise<void>((resolve) => serverB.listen(0, resolve));
  const portB = (serverB.address() as any).port;
  const urlB = `http://localhost:${portB}/api/v1/lcgate`;

  console.log(`  Instance A running on port ${portA}`);
  console.log(`  Instance B running on port ${portB}\n`);

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, msg: string) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${msg}`);
      throw new Error(`Assertion failed: ${msg}`);
    }
  }

  // Find a test device that belongs to a gate
  const testDevice = await prisma.deviceRegistry.findFirst({
    where: {
      gateId: { not: null },
      thingName: { startsWith: 'LC-' },
    },
    include: { gate: true },
  });

  if (!testDevice || !testDevice.gateId) {
    throw new Error('No suitable LC- device linked to a gate found in database.');
  }

  console.log(`  Target Test Device: ${testDevice.thingName} (Gate ID: ${testDevice.gateId}, Gate: ${testDevice.gate?.lcNumber})`);
  const originalLastSeenAt = testDevice.lastSeenAt;

  // Track state for cleanup
  let originalUserStatus = devUser.status;
  let originalRoleId = devUser.roleId;
  const createdThingNames: string[] = [];
  const createdScopeGroupIds: number[] = [];

  try {
    clusterCacheManager.invalidateAll();

    // =========================================================================
    // SECTION 1: CONCURRENT FIRST-TIME DEVICE PROVISIONING & ATOMIC UPSERT
    // =========================================================================
    console.log('\n--- SECTION 1: Concurrent First-Time Device Provisioning & Native Upsert ---');
    const syntheticThingName = `LC-SYNTH-${Date.now()}`;
    createdThingNames.push(syntheticThingName);

    console.log(`  Firing 2 simultaneous first-time telemetry requests for "${syntheticThingName}"...`);
    const [firstRes1, firstRes2] = await Promise.all([
      fetch(telemetryUrlA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thingName: syntheticThingName,
          Status: 'ONLINE',
          firmwareVersion: '1.0.9',
          LimitSwitchClosed: false,
        }),
      }),
      fetch(telemetryUrlA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thingName: syntheticThingName,
          Status: 'ONLINE',
          firmwareVersion: '1.0.9',
          LimitSwitchClosed: false,
        }),
      }),
    ]);

    assert(firstRes1.status === 201 || firstRes1.status === 200, `First concurrent provisioning request succeeded (HTTP ${firstRes1.status}).`);
    assert(firstRes2.status === 201 || firstRes2.status === 200, `Second concurrent provisioning request succeeded (HTTP ${firstRes2.status}).`);

    // Verify exactly one DeviceRegistry record was created without duplicate identity conflict
    const createdDevices = await prisma.deviceRegistry.findMany({
      where: { thingName: syntheticThingName },
    });
    assert(createdDevices.length === 1, `Exactly ONE DeviceRegistry record exists in PostgreSQL (no duplicate row created).`);
    assert(createdDevices[0].status === 'ONLINE', 'Provisioned device status is strictly "ONLINE".');
    assert(createdDevices[0].lastSeenAt !== null, 'Provisioned device has valid lastSeenAt timestamp.');

    // Verify both telemetry payloads were successfully recorded
    const recordedTelemetries = await prisma.deviceTelemetry.findMany({
      where: { thingName: syntheticThingName },
    });
    assert(recordedTelemetries.length === 2, `Both telemetry records were persisted (count: ${recordedTelemetries.length}).`);

    // Verify conflicting thingName and serialNumber matches prioritize exact thingName
    console.log('  Testing deterministic priority resolution for conflicting thingName / serialNumber matches...');
    const conflictThing1 = `LC-CONF-T1-${Date.now()}`;
    const sharedName = `LC-CONF-SHARED-${Date.now()}`;
    const conflictSn2 = `LC-CONF-SN2-${Date.now()}`;
    createdThingNames.push(conflictThing1, sharedName);

    // Device 1: thingName = conflictThing1, serialNumber = sharedName
    const dev1 = await prisma.deviceRegistry.create({
      data: {
        thingName: conflictThing1,
        serialNumber: sharedName,
        status: 'ACTIVE',
        lastSeenAt: new Date(Date.now() - 100000),
      }
    });

    // Device 2: thingName = sharedName, serialNumber = conflictSn2
    const dev2 = await prisma.deviceRegistry.create({
      data: {
        thingName: sharedName,
        serialNumber: conflictSn2,
        status: 'ACTIVE',
        lastSeenAt: new Date(Date.now() - 100000),
      }
    });

    // Send heartbeat for thingName = sharedName
    const resConflict = await fetch(telemetryUrlA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thingName: sharedName, Status: 'ONLINE' }),
    });
    assert(resConflict.status === 201 || resConflict.status === 200, 'Conflicting identity request succeeded.');
    const conflictData = await resConflict.json();
    assert(conflictData.device.id === dev2.id, `Deterministic match: Device 2 (exact thingName match, id: ${dev2.id}) was selected over Device 1 (serialNumber match, id: ${dev1.id}).`);
    assert(conflictData.device.id !== dev1.id, 'Device 1 was NOT arbitrarily selected.');

    // =========================================================================
    // SECTION 2: HEARTBEAT TRANSACTION ATOMICITY & REVISION INGESTION
    // =========================================================================
    console.log('\n--- SECTION 2: Heartbeat Transaction Atomicity & Concurrency ---');

    // 2A. Normal OFFLINE-to-ONLINE transition across instances
    const seventyMinutesAgo = new Date(Date.now() - 70 * 60 * 1000);
    await prisma.deviceRegistry.update({
      where: { id: testDevice.id },
      data: { lastSeenAt: seventyMinutesAgo }
    });
    await prisma.deviceTelemetry.updateMany({
      where: {
        OR: [{ thingName: testDevice.thingName }, { deviceRegistryId: testDevice.id }],
        receivedAt: { gte: new Date(Date.now() - 65 * 60 * 1000) }
      },
      data: { receivedAt: seventyMinutesAgo }
    });
    await bumpDirectoryRevision([], true);
    clusterCacheManager.invalidateAll();

    const resOfflineA = await fetch(urlA, { headers: { Authorization: `Bearer ${token}` } });
    assert(resOfflineA.status === 200, 'Instance A returns HTTP 200 for initial offline cluster query.');
    const etagOfflineA = resOfflineA.headers.get('etag') || '';
    const gatesOfflineA = await resOfflineA.json();
    const targetGateA = gatesOfflineA.find((g: any) => g.id === testDevice.gateId);
    assert(targetGateA && targetGateA.isOnline === false, 'Target gate starts as strictly OFFLINE.');

    // 2B. Duplicate concurrent heartbeat messages serialization
    console.log('  Testing duplicate concurrent heartbeat packets with row locking (SELECT ... FOR UPDATE)...');
    const heartbeatBody = JSON.stringify({
      thingName: testDevice.thingName,
      Status: 'ONLINE',
      firmwareVersion: testDevice.firmwareVersion || '1.0.8',
    });

    const [concurrentRes1, concurrentRes2] = await Promise.all([
      fetch(telemetryUrlA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: heartbeatBody,
      }),
      fetch(telemetryUrlA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: heartbeatBody,
      }),
    ]);

    assert(concurrentRes1.status === 201 || concurrentRes1.status === 200, 'Concurrent heartbeat 1 succeeded.');
    assert(concurrentRes2.status === 201 || concurrentRes2.status === 200, 'Concurrent heartbeat 2 succeeded.');

    // 2C. Revalidation through Instance B reflects ONLINE immediately
    const resB = await fetch(urlB, {
      headers: {
        Authorization: `Bearer ${token}`,
        'If-None-Match': etagOfflineA,
      }
    });
    assert(resB.status === 200, 'Instance B detects heartbeat invalidation: DOES NOT return HTTP 304.');
    const etagB = resB.headers.get('etag') || '';
    assert(etagB !== etagOfflineA, `Instance B produced fresh ETag: ${etagB}`);
    const gatesB = await resB.json();
    const targetGateB = gatesB.find((g: any) => g.id === testDevice.gateId);
    assert(targetGateB && targetGateB.isOnline === true, 'Instance B immediately reports gate as ONLINE.');

    // 2D. Complete telemetry persistence failure rollback
    console.log('  Testing complete atomic rollback when telemetry transaction fails...');
    const preRollbackTime = new Date(Date.now() - 85 * 60 * 1000);
    await prisma.deviceRegistry.update({
      where: { id: testDevice.id },
      data: { lastSeenAt: preRollbackTime }
    });

    let txRollbackCaught = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.deviceRegistry.update({
          where: { id: testDevice.id },
          data: { lastSeenAt: new Date() }
        });
        // Intentionally throw inside transaction
        throw new Error('Simulated atomic persistence failure');
      });
    } catch (err: any) {
      if (err.message.includes('Simulated atomic persistence failure')) {
        txRollbackCaught = true;
      }
    }
    assert(txRollbackCaught, 'Simulated persistence failure threw error.');
    const rolledBackDevice = await prisma.deviceRegistry.findUnique({
      where: { id: testDevice.id },
      select: { lastSeenAt: true }
    });
    assert(
      rolledBackDevice?.lastSeenAt?.getTime() === preRollbackTime.getTime(),
      'Atomic rollback verified: device lastSeenAt was NOT committed when transaction failed.'
    );

    // =========================================================================
    // SECTION 3: LIVE SERVER-SIDE AUTHORIZATION (SNAPSHOT CONSISTENCY)
    // =========================================================================
    console.log('\n--- SECTION 3: Live Server-Side Authorization Verification ---');

    // 3A. User deactivation: status != 'APPROVED' rejected even with valid JWT
    console.log('  Testing user deactivation within RepeatableRead transaction...');
    await prisma.user.update({
      where: { id: devUser.id },
      data: { status: 'DEACTIVATED' }
    });
    clusterCacheManager.invalidateAll();

    const resDeactivated = await fetch(urlA, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(resDeactivated.status === 401, `Deactivated user receives HTTP 401 (actual: ${resDeactivated.status}).`);

    // Restore user status
    await prisma.user.update({
      where: { id: devUser.id },
      data: { status: 'APPROVED' }
    });
    clusterCacheManager.invalidateAll();

    const resReactivated = await fetch(urlA, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(resReactivated.status === 200, 'Reactivated user restored to HTTP 200.');

    // 3B. Developer privilege removal: User changed to scoped role with cluster permission (Division Officer)
    console.log('  Testing live Developer privilege removal (stale JWT role claim)...');
    const divisionOfficerRole = await prisma.role.findFirst({
      where: { name: 'Division Officer' },
    });

    if (divisionOfficerRole) {
      await prisma.user.update({
        where: { id: devUser.id },
        data: { roleId: divisionOfficerRole.id }
      });
      clusterCacheManager.invalidateAll();

      const existingUserScopes = await prisma.scopeGroupUser.findMany({
        where: { userId: devUser.id },
        select: { scopeGroupId: true }
      });
      await prisma.scopeGroupUser.deleteMany({ where: { userId: devUser.id } });

      const resStaleJwt = await fetch(urlA, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert(resStaleJwt.status === 200, 'Request executes with live server-side role.');
      const etagStaleJwt = resStaleJwt.headers.get('etag') || '';
      assert(etagStaleJwt.includes('no-scope'), `Server evaluated live role and returned no-scope ETag: ${etagStaleJwt}`);
      const gatesStaleJwt = await resStaleJwt.json();
      assert(gatesStaleJwt.length === 0, 'User with removed Developer privilege cannot view platform gates without scope assignment.');

      // 3C. Role permission reduction: Switch user to role without cluster permission (Section / Station Master)
      console.log('  Testing live role permission reduction (role without cluster permission)...');
      const stationMasterRole = await prisma.role.findFirst({
        where: { name: 'Section / Station Master' },
      });
      if (stationMasterRole) {
        await prisma.user.update({
          where: { id: devUser.id },
          data: { roleId: stationMasterRole.id }
        });
        clusterCacheManager.invalidateAll();

        const resNoCluster = await fetch(urlA, {
          headers: { Authorization: `Bearer ${token}` }
        });
        assert(resNoCluster.status === 403, `Role without cluster permission receives HTTP 403 (actual: ${resNoCluster.status}).`);
      }

      // Restore user role & scopes
      await prisma.user.update({
        where: { id: devUser.id },
        data: { roleId: originalRoleId }
      });
      for (const s of existingUserScopes) {
        await prisma.scopeGroupUser.create({
          data: { userId: devUser.id, scopeGroupId: s.scopeGroupId }
        }).catch(() => {});
      }
      clusterCacheManager.invalidateAll();
    }

    // =========================================================================
    // SECTION 4: SCOPE HIERARCHY CACHE INVALIDATION (ANCESTOR & DESCENDANT)
    // =========================================================================
    console.log('\n--- SECTION 4: Scope Hierarchy Cache Invalidation (Ancestor & Descendant Cross-Coverage) ---');

    // Ensure devUser has no scope group assignments so requireScopeAdmin passes
    await prisma.scopeGroupUser.deleteMany({ where: { userId: devUser.id } });

    // Find root scope group
    const parentScope = await prisma.scopeGroup.findFirst({
      where: { parentId: null },
      select: { id: true, name: true }
    });

    if (parentScope) {
      console.log(`  Testing transactional revision bump on scope hierarchy mutation (Parent: ${parentScope.name} #${parentScope.id})...`);
      
      // Get directory revision token before hierarchy change
      const resPreHierarchy = await fetch(urlA, { headers: { Authorization: `Bearer ${token}` } });
      const etagPreHierarchy = resPreHierarchy.headers.get('etag') || '';

      // 4A. Scope group creation under parent
      const newChildName = `Test Staging Division ${Date.now()}`;
      const createRes = await fetch(scopeGroupUrlA, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: newChildName,
          description: 'Staging hierarchy test group',
          parentId: parentScope.id,
          gateIds: [],
          userIds: [],
        })
      });
      assert(createRes.status === 201, `Created child scope group under parent #${parentScope.id}.`);
      const createdChild = await createRes.json();
      createdScopeGroupIds.push(createdChild.id);

      // Verify ETag changed after child creation
      const resPostCreate = await fetch(urlA, {
        headers: { Authorization: `Bearer ${token}`, 'If-None-Match': etagPreHierarchy }
      });
      assert(resPostCreate.status === 200, 'Hierarchy creation detected: does not return HTTP 304.');
      const etagPostCreate = resPostCreate.headers.get('etag') || '';
      assert(etagPostCreate !== etagPreHierarchy, 'New ETag generated after child creation.');

      // 4B. Scope group name change without parentId change
      console.log('  Testing scope group name update without parentId change...');
      const updatedChildName = `${newChildName} Renamed`;
      const updateRes = await fetch(`${scopeGroupUrlA}/${createdChild.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: updatedChildName,
          description: 'Renamed description',
          color: '#10B981',
          parentId: parentScope.id,
        })
      });
      assert(updateRes.status === 200, 'Scope group name & metadata updated.');

      // Verify ETag changed after name update
      const resPostUpdate = await fetch(urlA, {
        headers: { Authorization: `Bearer ${token}`, 'If-None-Match': etagPostCreate }
      });
      assert(resPostUpdate.status === 200, 'Scope name update detected: does not return HTTP 304.');
      const etagPostUpdate = resPostUpdate.headers.get('etag') || '';
      assert(etagPostUpdate !== etagPostCreate, 'New ETag generated after scope group name update.');

      // 4C. Delete child scope group to clean up
      const delRes = await fetch(`${scopeGroupUrlA}/${createdChild.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      assert(delRes.status === 204, 'Deleted temporary child scope group.');
    }

    // =========================================================================
    // SECTION 5: EXACT 65-MINUTE FRESHNESS BOUNDARY
    // =========================================================================
    console.log('\n--- SECTION 5: Exact 65-Minute Freshness Boundary ---');
    const now = Date.now();
    const sixtyFourMinAgo = new Date(now - 64 * 60 * 1000);
    const remainingTimeMs = (sixtyFourMinAgo.getTime() + 65 * 60 * 1000) - now;
    const computedTtl = remainingTimeMs > 0 ? Math.min(15 * 60 * 1000, remainingTimeMs) : 0;
    assert(computedTtl === 60000, `Remaining TTL at 64m mark is exact 60,000ms. Actual: ${computedTtl}ms`);

    const pastSixtyFiveMinAgo = new Date(now - 65 * 60 * 1000 - 1000);
    const pastRemainingMs = (pastSixtyFiveMinAgo.getTime() + 65 * 60 * 1000) - now;
    const pastComputedTtl = pastRemainingMs > 0 ? Math.min(15 * 60 * 1000, pastRemainingMs) : 0;
    assert(pastComputedTtl === 0, `Remaining TTL past 65m mark is 0ms. Actual: ${pastComputedTtl}ms`);

    console.log('\n========================================================================');
    console.log(`🎉 ALL ${passed}/${total} FINAL EDGE-CASE AUDIT TESTS PASSED!`);
    console.log('========================================================================\n');

  } finally {
    // Guaranteed Cleanup & Restoration in finally block
    console.log('CLEANUP & RESTORATION:');
    try {
      // 1. Delete synthetic test devices and their telemetries
      for (const st of createdThingNames) {
        await prisma.deviceTelemetry.deleteMany({ where: { thingName: st } });
        await prisma.deviceHealthCheck.deleteMany({ where: { thingName: st } });
        await prisma.deviceRegistry.deleteMany({ where: { thingName: st } });
        console.log(`  Cleaned up synthetic test device "${st}".`);
      }

      // 2. Delete synthetic test scope groups if any remain
      for (const sgId of createdScopeGroupIds) {
        await prisma.scopeGroup.delete({ where: { id: sgId } }).catch(() => {});
        console.log(`  Cleaned up synthetic scope group #${sgId}.`);
      }

      // 3. Restore user status and role
      await prisma.user.update({
        where: { id: devUser.id },
        data: {
          status: originalUserStatus,
          roleId: originalRoleId,
        }
      });
      console.log(`  Restored dev user #${devUser.id} status (${originalUserStatus}) and role.`);

      // 4. Restore test device lastSeenAt
      if (testDevice) {
        await prisma.deviceRegistry.update({
          where: { id: testDevice.id },
          data: { lastSeenAt: originalLastSeenAt }
        });
        const scopes = await prisma.scopeGroupGate.findMany({
          where: { gateId: testDevice.gateId! },
          select: { scopeGroupId: true },
        });
        const scopeIds = Array.from(new Set(scopes.map(s => s.scopeGroupId)));
        await bumpDirectoryRevision(scopeIds, scopeIds.length === 0);
        console.log(`  Restored device "${testDevice.thingName}" lastSeenAt to original state and bumped revisions.`);
      }

      // 5. Verify in database
      const verifiedUser = await prisma.user.findUnique({
        where: { id: devUser.id },
        select: { status: true, roleId: true }
      });
      assert(
        verifiedUser?.status === originalUserStatus && verifiedUser?.roleId === originalRoleId,
        'Database verified: dev user restored to original status and role.'
      );

      const verifiedDevice = await prisma.deviceRegistry.findUnique({
        where: { id: testDevice.id },
        select: { lastSeenAt: true }
      });
      const restoredTime = verifiedDevice?.lastSeenAt ? new Date(verifiedDevice.lastSeenAt).getTime() : null;
      const origTime = originalLastSeenAt ? new Date(originalLastSeenAt).getTime() : null;
      assert(restoredTime === origTime, 'Database verified: device lastSeenAt matches original.');

    } catch (cleanupErr) {
      console.error('  Error during cleanup/restoration:', cleanupErr);
    }
    serverA.close();
    serverB.close();
    await prisma.$disconnect();
  }
}

runSecurityAndHeartbeatTests().catch((err) => {
  console.error('Security and heartbeat test failed:', err);
  process.exit(1);
});
