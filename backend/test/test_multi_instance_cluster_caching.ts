import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import lcgateRoutes from '../src/routes/lcgate';
import { bumpDirectoryRevision } from '../src/lib/revisionManager';
import { errorHandler } from '../src/middleware/error';

async function runMultiInstanceTests() {
  console.log('========================================================================');
  console.log('🌐 VERIFYING MULTI-INSTANCE CACHE CONSISTENCY (TWO BACKEND INSTANCES)');
  console.log('========================================================================\n');

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
  appA.use(errorHandler);
  const serverA = http.createServer(appA);
  await new Promise<void>((resolve) => serverA.listen(0, resolve));
  const portA = (serverA.address() as any).port;
  const urlA = `http://localhost:${portA}/api/v1/lcgate`;

  // Setup Instance B
  const appB = express();
  appB.use(express.json());
  appB.use('/api/v1/lcgate', lcgateRoutes);
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

  // Dynamically capture test gate and its original unmodified values
  const testGate = await prisma.lCGate.findFirst({
    orderBy: { id: 'asc' },
    select: { id: true, name: true, locationName: true }
  });

  if (!testGate) {
    throw new Error('No gates in database to test mutations on.');
  }

  const originalLocation = testGate.locationName;
  const testMutationLocation = `Multi-Instance Test Loc ${Date.now()}`;

  try {
    console.log('STEP 1: Instance A loads and caches Cluster data');
    const resA1 = await fetch(urlA, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(resA1.status === 200, 'Instance A returns HTTP 200 on initial fetch');
    const etagA1 = resA1.headers.get('etag') || '';
    assert(etagA1.length > 0, `Instance A sets ETag: ${etagA1}`);

    // Revalidate on Instance A to prove it is cached and returns 304
    const resA2 = await fetch(urlA, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'If-None-Match': etagA1,
      }
    });
    assert(resA2.status === 304, 'Instance A returns HTTP 304 on repeated request with ETag A1');

    console.log('\nSTEP 2: Mutation occurs through independent Instance B');
    const resB = await fetch(`${urlB}/${testGate.id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locationName: testMutationLocation,
      })
    });
    assert(resB.status === 200, 'Instance B successfully mutates gate location via PUT');
    const updatedGateB = await resB.json();
    assert(updatedGateB.locationName === testMutationLocation, 'Gate location updated in PostgreSQL via Instance B');

    console.log('\nSTEP 3: Instance A receives another request with the previous ETag A1');
    const resA3 = await fetch(urlA, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'If-None-Match': etagA1,
      }
    });

    assert(resA3.status === 200, 'Instance A detects mutation: DOES NOT return HTTP 304');
    const etagA3 = resA3.headers.get('etag') || '';
    assert(etagA3 !== etagA1, `Instance A generates new ETag: ${etagA3} (differs from old ${etagA1})`);

    const gatesA3 = await resA3.json();
    const mutatedGateA = gatesA3.find((g: any) => g.id === testGate.id);
    assert(mutatedGateA && mutatedGateA.locationName === testMutationLocation, 
      `Instance A returns fresh mutated data: "${mutatedGateA?.locationName}"`);

    console.log('\n========================================================================');
    console.log(`🎉 ALL ${passed}/${total} MULTI-INSTANCE CONSISTENCY TESTS PASSED!`);
    console.log('========================================================================\n');

  } finally {
    try {
      console.log('CLEANUP & RESTORATION:');
      const currentGate = await prisma.lCGate.findUnique({
        where: { id: testGate.id },
        select: { locationName: true }
      });
      if (currentGate && currentGate.locationName !== originalLocation) {
        await prisma.lCGate.update({
          where: { id: testGate.id },
          data: { locationName: originalLocation }
        });
        const scopes = await prisma.scopeGroupGate.findMany({
          where: { gateId: testGate.id },
          select: { scopeGroupId: true }
        });
        const scopeIds = Array.from(new Set(scopes.map(s => s.scopeGroupId)));
        await bumpDirectoryRevision(scopeIds, scopeIds.length === 0);
        console.log(`  Restored gate #${testGate.id} locationName to "${originalLocation}" and bumped directory revision.`);
      }
      const verified = await prisma.lCGate.findUnique({
        where: { id: testGate.id },
        select: { locationName: true }
      });
      if (verified?.locationName === originalLocation) {
        console.log(`  ✅ [PASS] Verified database restoration: gate #${testGate.id} locationName is "${originalLocation}"`);
      } else {
        console.error(`  ❌ [FAIL] Database restoration verification failed: expected "${originalLocation}", got "${verified?.locationName}"`);
      }
    } catch (cleanupErr) {
      console.error('  Error during cleanup/restoration:', cleanupErr);
    }
    serverA.close();
    serverB.close();
    await prisma.$disconnect();
  }
}

runMultiInstanceTests().catch((err) => {
  console.error('Multi-instance test failed:', err);
  process.exit(1);
});

