import http from 'http';
import jwt from 'jsonwebtoken';
import express from 'express';
import { prisma } from '../src/lib/prisma';
import reportsRoutes from '../src/routes/reports';
import { errorHandler } from '../src/middleware/error';
import { bumpDirectoryRevision, getDirectoryRevisionToken } from '../src/lib/revisionManager';

async function runPermissionRevocationTest() {
  console.log('========================================================================');
  console.log('🔐 LIVE INTEGRATION TEST: PERMISSION REVOCATION & SCOPE REDUCTION');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, title: string, details?: string) {
    if (condition) {
      console.log(`  ✅ [PASS] ${title}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${title}${details ? ` -> ${details}` : ''}`);
      failed++;
      process.exitCode = 1;
    }
  }

  // Find a non-developer role in the database
  let role = await prisma.role.findFirst({
    where: {
      name: { notIn: ['Developer', 'DEVELOPER', 'Admin', 'ADMIN'] }
    }
  });

  if (!role) {
    // Create a temporary non-developer role if none exists
    role = await prisma.role.create({
      data: { name: `FieldOperator_Test_${Date.now()}` }
    });
  }

  // Express test app
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1/reports`;

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-jwt-key';

  // Synthetic resources tracking for safe cleanup
  const syntheticGateIds: number[] = [];
  const syntheticScopeIds: number[] = [];
  let testUser: any = null;

  try {
    console.log('1. Setting up 20 synthetic gates across 2 Scope Groups (10 gates each)...');

    // Create Scope Group Alpha
    const scopeAlpha = await prisma.scopeGroup.create({
      data: { name: `TEST_SCOPE_ALPHA_${Date.now()}`, color: '#10B981' }
    });
    syntheticScopeIds.push(scopeAlpha.id);

    // Create Scope Group Beta
    const scopeBeta = await prisma.scopeGroup.create({
      data: { name: `TEST_SCOPE_BETA_${Date.now()}`, color: '#3B82F6' }
    });
    syntheticScopeIds.push(scopeBeta.id);

    // Create 10 gates in Scope Alpha
    const alphaGateIds: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const g = await prisma.lCGate.create({
        data: {
          lcNumber: `TEST-PERM-A-${i}-${Date.now()}`,
          name: `Perm Gate Alpha ${i}`,
          locationName: `Location A${i}`,
          zone: 'West',
          division: 'TestDiv',
        }
      });
      alphaGateIds.push(g.id);
      syntheticGateIds.push(g.id);
      await prisma.scopeGroupGate.create({
        data: { scopeGroupId: scopeAlpha.id, gateId: g.id }
      });
      // Add synthetic event
      await prisma.lCGateEvent.create({
        data: {
          gateId: g.id,
          openedAt: new Date('2026-06-01T10:00:00Z'),
          closedAt: new Date('2026-06-01T10:05:00Z'),
          durationSeconds: 300,
          status: 'CLOSED',
        }
      });
    }

    // Create 10 gates in Scope Beta
    const betaGateIds: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const g = await prisma.lCGate.create({
        data: {
          lcNumber: `TEST-PERM-B-${i}-${Date.now()}`,
          name: `Perm Gate Beta ${i}`,
          locationName: `Location B${i}`,
          zone: 'West',
          division: 'TestDiv',
        }
      });
      betaGateIds.push(g.id);
      syntheticGateIds.push(g.id);
      await prisma.scopeGroupGate.create({
        data: { scopeGroupId: scopeBeta.id, gateId: g.id }
      });
      // Add synthetic event
      await prisma.lCGateEvent.create({
        data: {
          gateId: g.id,
          openedAt: new Date('2026-06-01T11:00:00Z'),
          closedAt: new Date('2026-06-01T11:08:00Z'),
          durationSeconds: 480,
          status: 'CLOSED',
        }
      });
    }

    // Create synthetic User A
    testUser = await prisma.user.create({
      data: {
        fullName: 'Test Perm User A',
        email: `test_perm_a_${Date.now()}@lcgate.in`,
        mobile: `99${Date.now().toString().slice(-8)}`,
        employeeId: `EMP-${Date.now()}`,
        department: 'Operations',
        passwordHash: 'dummy-hash',
        roleId: role.id,
        status: 'APPROVED',
      }
    });

    // Assign User A to BOTH Scope Alpha and Scope Beta (20 gates total)
    await prisma.scopeGroupUser.createMany({
      data: [
        { userId: testUser.id, scopeGroupId: scopeAlpha.id },
        { userId: testUser.id, scopeGroupId: scopeBeta.id },
      ]
    });

    const userToken = jwt.sign(
      { userId: testUser.id, email: testUser.email, role: role.name },
      jwtSecret,
      { expiresIn: '1h' }
    );
    const headers = {
      'Authorization': `Bearer ${userToken}`,
      'Content-Type': 'application/json',
    };

    console.log('2. Verifying initial state: User A has access to 20 gates...');

    // 2a. Fetch clusters
    const clusterRes1 = await fetch(`${baseUrl}/clusters`, { headers });
    assert(clusterRes1.status === 200, 'Initial GET /clusters returns HTTP 200');
    const clusterData1 = await clusterRes1.json();
    const initialDirToken = clusterRes1.headers.get('etag');
    assert(!!initialDirToken, 'Initial GET /clusters returns ETag header', initialDirToken || undefined);

    const initialGates = clusterData1.clusters.flatMap((c: any) => c.gates);
    assert(initialGates.length === 20, 'Initial clusters contain exactly 20 gates', `Found ${initialGates.length}`);
    assert(clusterData1.clusters.length === 2, 'Initial clusters contain both Scope Alpha and Scope Beta');

    // 2b. Fetch records
    const recRes1 = await fetch(`${baseUrl}/records?startDate=2026-01-01&endDate=2026-12-31`, { headers });
    assert(recRes1.status === 200, 'Initial GET /records returns HTTP 200');
    const initialReportEtag = recRes1.headers.get('etag');
    const recData1 = await recRes1.json();
    assert(recData1.records.length === 20, 'Initial records contain 20 events across all 20 gates', `Found ${recData1.records.length}`);
    assert(!!initialReportEtag, 'Initial GET /records returns ETag header');

    // 2c. Re-requesting with ETag returns HTTP 304 Not Modified
    const recRes1Cached = await fetch(`${baseUrl}/records?startDate=2026-01-01&endDate=2026-12-31`, {
      headers: { ...headers, 'If-None-Match': initialReportEtag! }
    });
    assert(recRes1Cached.status === 304, 'Conditional GET /records with valid ETag returns HTTP 304');

    const clusterRes1Cached = await fetch(`${baseUrl}/clusters`, {
      headers: { ...headers, 'If-None-Match': initialDirToken! }
    });
    assert(clusterRes1Cached.status === 304, 'Conditional GET /clusters with valid ETag returns HTTP 304');

    console.log('\n3. Simulating Administrator Revocation: Removing Scope Beta from User A...');

    // Admin unassigns Scope Beta from User A (reducing access from 20 gates down to 10 gates)
    await prisma.scopeGroupUser.deleteMany({
      where: {
        userId: testUser.id,
        scopeGroupId: scopeBeta.id,
      }
    });

    // Bumps directory revision for Scope Beta
    await bumpDirectoryRevision([scopeBeta.id]);

    console.log('\n4. User A returns online with previously cached ETags...');

    // 4a. User A requests /clusters with previous ETag
    const clusterRes2 = await fetch(`${baseUrl}/clusters`, {
      headers: { ...headers, 'If-None-Match': initialDirToken! }
    });
    assert(clusterRes2.status === 200, 'GET /clusters rejects previous 20-gate ETag and returns HTTP 200 (NOT 304)');
    const clusterData2 = await clusterRes2.json();
    const newDirToken = clusterRes2.headers.get('etag');
    assert(newDirToken !== initialDirToken, 'New directory revision token differs from initial token');
    const updatedGates = clusterData2.clusters.flatMap((c: any) => c.gates);
    assert(updatedGates.length === 10, 'Updated clusters contain strictly the remaining 10 authorized gates', `Found ${updatedGates.length}`);
    const updatedGateIds = updatedGates.map((g: any) => g.id);
    const hasAnyBetaGate = betaGateIds.some(id => updatedGateIds.includes(id));
    assert(!hasAnyBetaGate, 'No revoked Beta gates are present in the clusters response');

    // 4b. User A requests /records with previous report ETag
    const recRes2 = await fetch(`${baseUrl}/records?startDate=2026-01-01&endDate=2026-12-31`, {
      headers: { ...headers, 'If-None-Match': initialReportEtag! }
    });
    assert(recRes2.status === 200, 'GET /records rejects previous 20-gate report ETag and returns HTTP 200 (NOT 304)');
    const recData2 = await recRes2.json();
    const newReportEtag = recRes2.headers.get('etag');
    assert(newReportEtag !== initialReportEtag, 'New report ETag differs from initial report ETag');
    assert(recData2.records.length === 10, 'Returned records contain strictly 10 authorized events', `Found ${recData2.records.length}`);
    const returnedGateIds = recData2.records.map((r: any) => r.gateId);
    const hasAnyRevokedRecord = betaGateIds.some(id => returnedGateIds.includes(id));
    assert(!hasAnyRevokedRecord, 'Zero records from revoked gates are returned in report records');

    console.log('\n5. Incremental Polling Verification with Revoked Gates...');

    // Client polling with gateRevisions containing both Alpha and Revoked Beta gates
    const clientRevs: Record<string, string> = {};
    for (const id of syntheticGateIds) {
      clientRevs[id.toString()] = '1';
    }

    const changesRes = await fetch(`${baseUrl}/records/changes?gateRevisions=${encodeURIComponent(JSON.stringify(clientRevs))}`, {
      headers
    });
    assert(changesRes.status === 200, 'GET /records/changes returns HTTP 200');
    const changesData = await changesRes.json();
    assert(changesData.requiresFullSync === true, 'Changes response signals requiresFullSync: true on revoked gate detection');
    assert(changesData.resyncReason === 'GATE_REVOKED', 'Changes response returns resyncReason: "GATE_REVOKED"');
    assert(changesData.events.length === 0, 'No events returned during GATE_REVOKED resync signal');

    // Client polling with explicit gateIds query parameter containing revoked gates
    const changesParamRes = await fetch(`${baseUrl}/records/changes?gateIds=${syntheticGateIds.join(',')}`, {
      headers
    });
    const changesParamData = await changesParamRes.json();
    assert(changesParamData.requiresFullSync === true, 'Explicit gateIds param containing revoked gates signals requiresFullSync: true');
    assert(changesParamData.resyncReason === 'GATE_REVOKED', 'Explicit gateIds param returns resyncReason: "GATE_REVOKED"');

  } finally {
    console.log('\n🧹 Cleaning up all synthetic test gates, scopes, events, and user...');
    if (syntheticGateIds.length > 0) {
      await prisma.lCGateEvent.deleteMany({ where: { gateId: { in: syntheticGateIds } } });
      await prisma.lCGateEventChangeLog.deleteMany({ where: { gateId: { in: syntheticGateIds } } });
      await prisma.lCGateEventTombstone.deleteMany({ where: { gateId: { in: syntheticGateIds } } });
      await prisma.scopeGroupGate.deleteMany({ where: { gateId: { in: syntheticGateIds } } });
      await prisma.lCGate.deleteMany({ where: { id: { in: syntheticGateIds } } });
    }
    if (testUser) {
      await prisma.scopeGroupUser.deleteMany({ where: { userId: testUser.id } });
      await prisma.user.delete({ where: { id: testUser.id } });
    }
    if (syntheticScopeIds.length > 0) {
      await prisma.scopeGroup.deleteMany({ where: { id: { in: syntheticScopeIds } } });
    }
    server.close();
    console.log('Cleanup completed successfully.');
  }

  console.log('\n========================================================================');
  console.log(`📊 PERMISSION REVOCATION VERIFICATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPermissionRevocationTest().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
