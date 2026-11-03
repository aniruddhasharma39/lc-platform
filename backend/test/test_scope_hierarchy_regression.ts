import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import lcgateRoutes from '../src/routes/lcgate';
import scopeGroupRoutes from '../src/routes/scopeGroups';
import { clusterCacheManager } from '../src/lib/clusterCacheManager';
import { errorHandler } from '../src/middleware/error';

async function runScopeHierarchyRegressionTests() {
  console.log('========================================================================');
  console.log('🌳 SCOPE HIERARCHY CACHE REGRESSION & REVALIDATION AUDIT');
  console.log('========================================================================\n');

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-jwt-key';

  // 1. Find or verify Developer user for administrative mutations
  const devUser = await prisma.user.findFirst({
    where: { status: 'APPROVED', role: { name: 'Developer' } },
    include: { role: true },
  });
  if (!devUser) throw new Error('Developer user not found in database.');

  const adminToken = jwt.sign(
    { userId: devUser.id, email: devUser.email, role: 'Developer' },
    jwtSecret,
    { expiresIn: '1h' }
  );

  // 2. Find Division Officer role for scoped users
  const divisionOfficerRole = await prisma.role.findFirst({
    where: { name: 'Division Officer' },
  });
  if (!divisionOfficerRole) throw new Error('Division Officer role not found.');

  // Find a test gate (Panvel Gate #17)
  const testGate = await prisma.lCGate.findFirst({
    where: { id: 17 },
  }) || await prisma.lCGate.findFirst();
  if (!testGate) throw new Error('No test gate found in database.');

  console.log(`  Target Test Gate: ID ${testGate.id} (${testGate.lcNumber})`);

  // Setup Express server with lcgate and scopeGroups routes
  const app = express();
  app.use(express.json());
  app.use('/api/v1/lcgate', lcgateRoutes);
  app.use('/api/v1/scope-groups', scopeGroupRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const clusterUrl = `http://localhost:${port}/api/v1/lcgate`;
  const scopeGroupUrl = `http://localhost:${port}/api/v1/scope-groups`;

  console.log(`  Test server running on port ${port}\n`);

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

  // Tracking created entities for guaranteed cleanup
  const createdUserIds: number[] = [];
  const createdScopeGroupIds: number[] = [];
  let userAToken = '';
  let userBToken = '';
  let userCToken = '';

  try {
    clusterCacheManager.invalidateAll();

    // -------------------------------------------------------------------------
    // STEP 1: HIERARCHY SETUP
    // Parent Scope A, Parent Scope B, Child Scope C (under A), Child Scope D (under A)
    // -------------------------------------------------------------------------
    console.log('--- STEP 1: Creating Multi-Level Hierarchy with Multiple Descendants ---');

    // Create Parent Scope A
    const parentARes = await fetch(scopeGroupUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Test Parent Scope A ${Date.now()}`,
        description: 'Root scope A for hierarchy test',
        color: '#1E3A8A',
        parentId: null,
        gateIds: [],
        userIds: [],
      })
    });
    assert(parentARes.status === 201, 'Created Parent Scope A.');
    const parentA = await parentARes.json();
    createdScopeGroupIds.push(parentA.id);

    // Create Parent Scope B
    const parentBRes = await fetch(scopeGroupUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Test Parent Scope B ${Date.now()}`,
        description: 'Root scope B for hierarchy test',
        color: '#065F46',
        parentId: null,
        gateIds: [],
        userIds: [],
      })
    });
    assert(parentBRes.status === 201, 'Created Parent Scope B.');
    const parentB = await parentBRes.json();
    createdScopeGroupIds.push(parentB.id);

    // Create Child Scope C under Parent A (assign testGate)
    const childCRes = await fetch(scopeGroupUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Test Child Scope C ${Date.now()}`,
        description: 'Child scope C under Parent A',
        color: '#2563EB',
        parentId: parentA.id,
        gateIds: [testGate.id],
        userIds: [],
      })
    });
    assert(childCRes.status === 201, 'Created Child Scope C under Parent A (with Gate assigned).');
    const childC = await childCRes.json();
    createdScopeGroupIds.push(childC.id);

    // Create Child Scope D under Parent A (Multiple descendants under Parent A)
    const childDRes = await fetch(scopeGroupUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Test Child Scope D ${Date.now()}`,
        description: 'Second child scope D under Parent A',
        color: '#3B82F6',
        parentId: parentA.id,
        gateIds: [],
        userIds: [],
      })
    });
    assert(childDRes.status === 201, 'Created Child Scope D under Parent A (multiple descendants confirmed).');
    const childD = await childDRes.json();
    createdScopeGroupIds.push(childD.id);

    // -------------------------------------------------------------------------
    // STEP 2: USER PROVISIONING & DIRECT SCOPE ASSIGNMENTS
    // User A -> Parent A
    // User B -> Parent B
    // User C -> Child C
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 2: Provisioning Scoped Users & Direct Scope Assignments ---');

    // Create User A (Directly assigned to Parent A)
    const userA = await prisma.user.create({
      data: {
        email: `test_user_a_${Date.now()}@vasp.test`,
        fullName: 'Test Officer User A (Parent A)',
        mobile: `+91999${String(Date.now()).slice(-7)}1`,
        employeeId: `EMP-A-${Date.now()}`,
        department: 'Operations',
        passwordHash: 'dummyhash',
        status: 'APPROVED',
        roleId: divisionOfficerRole.id,
        scopeGroups: { create: { scopeGroupId: parentA.id } },
      }
    });
    createdUserIds.push(userA.id);
    userAToken = jwt.sign({ userId: userA.id, email: userA.email, role: 'Division Officer' }, jwtSecret, { expiresIn: '1h' });

    // Create User B (Directly assigned to Parent B)
    const userB = await prisma.user.create({
      data: {
        email: `test_user_b_${Date.now()}@vasp.test`,
        fullName: 'Test Officer User B (Parent B)',
        mobile: `+91999${String(Date.now()).slice(-7)}2`,
        employeeId: `EMP-B-${Date.now()}`,
        department: 'Operations',
        passwordHash: 'dummyhash',
        status: 'APPROVED',
        roleId: divisionOfficerRole.id,
        scopeGroups: { create: { scopeGroupId: parentB.id } },
      }
    });
    createdUserIds.push(userB.id);
    userBToken = jwt.sign({ userId: userB.id, email: userB.email, role: 'Division Officer' }, jwtSecret, { expiresIn: '1h' });

    // Create User C (Directly assigned to Child Scope C)
    const userC = await prisma.user.create({
      data: {
        email: `test_user_c_${Date.now()}@vasp.test`,
        fullName: 'Test Officer User C (Child C)',
        mobile: `+91999${String(Date.now()).slice(-7)}3`,
        employeeId: `EMP-C-${Date.now()}`,
        department: 'Operations',
        passwordHash: 'dummyhash',
        status: 'APPROVED',
        roleId: divisionOfficerRole.id,
        scopeGroups: { create: { scopeGroupId: childC.id } },
      }
    });
    createdUserIds.push(userC.id);
    userCToken = jwt.sign({ userId: userC.id, email: userC.email, role: 'Division Officer' }, jwtSecret, { expiresIn: '1h' });

    clusterCacheManager.invalidateAll();

    // -------------------------------------------------------------------------
    // STEP 3: INITIAL CLUSTER DIRECTORY FETCH & CONDITIONAL 304 CACHING
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 3: Initial Cluster Directory Fetch & Conditional 304 Caching ---');

    // User A fetches cluster directory
    const resA1 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userAToken}` } });
    assert(resA1.status === 200, 'User A (Parent A) successfully fetches directory (HTTP 200).');
    const etagA1 = resA1.headers.get('etag') || '';
    const gatesA1 = await resA1.json();
    assert(gatesA1.some((g: any) => g.id === testGate.id), 'User A accesses Gate via descendant Child Scope C.');

    // User B fetches cluster directory
    const resB1 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userBToken}` } });
    assert(resB1.status === 200, 'User B (Parent B) successfully fetches directory (HTTP 200).');
    const etagB1 = resB1.headers.get('etag') || '';
    const gatesB1 = await resB1.json();
    assert(!gatesB1.some((g: any) => g.id === testGate.id), 'User B does NOT see Gate (isolated from Parent A).');

    // User C fetches cluster directory
    const resC1 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userCToken}` } });
    assert(resC1.status === 200, 'User C (Child C) successfully fetches directory (HTTP 200).');
    const etagC1 = resC1.headers.get('etag') || '';
    const gatesC1 = await resC1.json();
    assert(gatesC1.some((g: any) => g.id === testGate.id), 'User C accesses Gate directly in Child Scope C.');

    // Verify HTTP 304 for all three users
    const [revalA1, revalB1, revalC1] = await Promise.all([
      fetch(clusterUrl, { headers: { Authorization: `Bearer ${userAToken}`, 'If-None-Match': etagA1 } }),
      fetch(clusterUrl, { headers: { Authorization: `Bearer ${userBToken}`, 'If-None-Match': etagB1 } }),
      fetch(clusterUrl, { headers: { Authorization: `Bearer ${userCToken}`, 'If-None-Match': etagC1 } }),
    ]);
    assert(revalA1.status === 304, 'User A repeated request returns HTTP 304 Not Modified.');
    assert(revalB1.status === 304, 'User B repeated request returns HTTP 304 Not Modified.');
    assert(revalC1.status === 304, 'User C repeated request returns HTTP 304 Not Modified.');

    // -------------------------------------------------------------------------
    // STEP 4: PARENT NAME & METADATA UPDATE (OLD-PARENT REVISION BUMP)
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 4: Parent Scope Name & Metadata Update ---');
    const updatedParentAName = `Parent Scope A Renamed ${Date.now()}`;
    const updateParentARes = await fetch(`${scopeGroupUrl}/${parentA.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: updatedParentAName,
        description: 'Updated description for parent A',
        color: '#DC2626',
        parentId: null,
      })
    });
    assert(updateParentARes.status === 200, 'Parent Scope A name & metadata updated.');

    // User A revalidates with old ETag -> MUST return HTTP 200 with new data
    const resA2 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userAToken}`, 'If-None-Match': etagA1 } });
    assert(resA2.status === 200, 'User A receives HTTP 200 (cache invalidated by Parent A metadata update).');
    const etagA2 = resA2.headers.get('etag') || '';
    assert(etagA2 !== etagA1, 'User A receives fresh ETag reflecting parent metadata update.');

    // User C revalidates with old ETag -> MUST return HTTP 200 because Child C is under Parent A
    const resC2 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userCToken}`, 'If-None-Match': etagC1 } });
    assert(resC2.status === 200, 'User C (Child scope) receives HTTP 200 (ancestor revision bump invalidated Child C).');
    const etagC2 = resC2.headers.get('etag') || '';
    assert(etagC2 !== etagC1, 'User C receives fresh ETag.');
    const gatesC2 = await resC2.json();
    const gateScopeForC = gatesC2[0].scopeGroups.find((sg: any) => (sg.scopeGroup ? sg.scopeGroup.id : sg.scopeGroupId) === childC.id);
    const parentScopeObj = gateScopeForC?.scopeGroup?.parent;
    assert(parentScopeObj?.name === updatedParentAName, `Child C gate data shows updated parent name: "${parentScopeObj?.name}".`);

    // User B revalidates -> Unrelated Parent B MUST continue receiving HTTP 304
    const resB2 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userBToken}`, 'If-None-Match': etagB1 } });
    assert(resB2.status === 304, 'User B (Parent B) cache preserved (HTTP 304 - unaffected by Parent A update).');

    // -------------------------------------------------------------------------
    // STEP 5: MOVING CHILD SCOPE FROM PARENT A TO PARENT B
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 5: Moving Child Scope C from Parent A to Parent B ---');
    const moveRes = await fetch(`${scopeGroupUrl}/${childC.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: childC.name,
        description: 'Child scope C moved to Parent B',
        color: childC.color,
        parentId: parentB.id, // Move parent from A to B
      })
    });
    assert(moveRes.status === 200, 'Child Scope C successfully moved to Parent B.');

    // User A (Old Parent) revalidates with etagA2 -> MUST return HTTP 200 and NO LONGER see Gate
    const resA3 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userAToken}`, 'If-None-Match': etagA2 } });
    assert(resA3.status === 200, 'User A (Old Parent) receives HTTP 200 (old-parent cache invalidated).');
    const etagA3 = resA3.headers.get('etag') || '';
    assert(etagA3 !== etagA2, 'User A receives fresh ETag after child moved out.');
    const gatesA3 = await resA3.json();
    assert(!gatesA3.some((g: any) => g.id === testGate.id), 'Gate is no longer accessible to User A (Child C moved to Parent B).');

    // User B (New Parent) revalidates with etagB1 -> MUST return HTTP 200 and NOW see Gate
    const resB3 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userBToken}`, 'If-None-Match': etagB1 } });
    assert(resB3.status === 200, 'User B (New Parent) receives HTTP 200 (new-parent cache invalidated).');
    const etagB3 = resB3.headers.get('etag') || '';
    assert(etagB3 !== etagB1, 'User B receives fresh ETag after child moved in.');
    const gatesB3 = await resB3.json();
    assert(gatesB3.some((g: any) => g.id === testGate.id), 'Gate is NOW accessible to User B through moved Child Scope C.');

    // User C (Moved Child) revalidates with etagC2 -> MUST return HTTP 200 with updated parentId
    const resC3 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userCToken}`, 'If-None-Match': etagC2 } });
    assert(resC3.status === 200, 'User C (Moved Child) receives HTTP 200.');
    const etagC3 = resC3.headers.get('etag') || '';
    assert(etagC3 !== etagC2, 'User C receives fresh ETag.');
    const gatesC3 = await resC3.json();
    const gateScopeForC3 = gatesC3[0].scopeGroups.find((sg: any) => (sg.scopeGroup ? sg.scopeGroup.id : sg.scopeGroupId) === childC.id);
    const parentScopeObj3 = gateScopeForC3?.scopeGroup?.parent;
    assert(parentScopeObj3?.id === parentB.id, `Child C parent is now Parent B (ID: ${parentB.id}).`);

    // -------------------------------------------------------------------------
    // STEP 6: GATE ASSIGNMENT CHANGES WITHIN NESTED SCOPES
    // Move Gate from Child C (under B) to Child D (under A)
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 6: Gate Assignment Changes Within Nested Scopes ---');

    // Remove Gate from Child C
    const removeGateRes = await fetch(`${scopeGroupUrl}/${childC.id}/gates`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateIds: [] })
    });
    assert(removeGateRes.status === 200, 'Removed Gate from Child Scope C.');

    // Assign Gate to Child D (which is under Parent A)
    const assignGateRes = await fetch(`${scopeGroupUrl}/${childD.id}/gates`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateIds: [testGate.id] })
    });
    assert(assignGateRes.status === 200, 'Assigned Gate to Child Scope D (under Parent A).');

    // User A (Parent A) revalidates -> MUST receive HTTP 200 and see Gate again through Child D
    const resA4 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userAToken}`, 'If-None-Match': etagA3 } });
    assert(resA4.status === 200, 'User A receives HTTP 200 after Gate assigned to Child D.');
    const gatesA4 = await resA4.json();
    assert(gatesA4.some((g: any) => g.id === testGate.id), 'Gate is again accessible to User A through nested Child D.');

    // User B (Parent B) revalidates -> MUST receive HTTP 200 and NO LONGER see Gate
    const resB4 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userBToken}`, 'If-None-Match': etagB3 } });
    assert(resB4.status === 200, 'User B receives HTTP 200 after Gate removed from Child C.');
    const gatesB4 = await resB4.json();
    assert(!gatesB4.some((g: any) => g.id === testGate.id), 'Gate is no longer accessible to User B.');

    // User C (Child C) revalidates -> MUST receive HTTP 200 and NO LONGER see Gate
    const resC4 = await fetch(clusterUrl, { headers: { Authorization: `Bearer ${userCToken}`, 'If-None-Match': etagC3 } });
    assert(resC4.status === 200, 'User C receives HTTP 200 after Gate removed.');
    const gatesC4 = await resC4.json();
    assert(!gatesC4.some((g: any) => g.id === testGate.id), 'Gate is no longer accessible to User C.');

    console.log('\n========================================================================');
    console.log(`🎉 ALL ${passed}/${total} SCOPE HIERARCHY REGRESSION TESTS PASSED!`);
    console.log('========================================================================\n');

  } finally {
    console.log('CLEANUP & RESTORATION:');
    try {
      // 1. Delete user-to-scope assignments
      for (const uid of createdUserIds) {
        await prisma.scopeGroupUser.deleteMany({ where: { userId: uid } });
      }

      // 2. Delete test users
      for (const uid of createdUserIds) {
        await prisma.user.delete({ where: { id: uid } }).catch(() => {});
        console.log(`  Deleted test user #${uid}.`);
      }

      // 3. Delete gate assignments in created scope groups
      for (const sgId of createdScopeGroupIds) {
        await prisma.scopeGroupGate.deleteMany({ where: { scopeGroupId: sgId } });
      }

      // 4. Delete child scope groups first, then parent scope groups
      for (const sgId of createdScopeGroupIds.slice().reverse()) {
        await prisma.scopeGroup.delete({ where: { id: sgId } }).catch(() => {});
        console.log(`  Deleted test scope group #${sgId}.`);
      }

      // 5. Invalidate caches and bump revisions
      clusterCacheManager.invalidateAll();
      console.log('  Cleaned up all temporary hierarchy test entities.');
    } catch (cleanupErr) {
      console.error('  Error during cleanup:', cleanupErr);
    }
    server.close();
    await prisma.$disconnect();
  }
}

runScopeHierarchyRegressionTests().catch((err) => {
  console.error('Scope hierarchy test suite failed:', err);
  process.exit(1);
});
