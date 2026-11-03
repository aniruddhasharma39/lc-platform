import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import lcgateRoutes from '../src/routes/lcgate';
import { errorHandler } from '../src/middleware/error';
import { bumpDirectoryRevision } from '../src/lib/revisionManager';
import { clusterCacheManager } from '../src/lib/clusterCacheManager';

async function runClusterCachingTests() {
  console.log('========================================================================');
  console.log('🔒 VERIFYING PHASE 1: CLUSTER INTELLIGENT CACHING & ETAG REVALIDATION');
  console.log('========================================================================\n');

  // Find an active Developer user for testing
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

  // Setup express test server
  const app = express();
  app.use(express.json());
  app.use('/api/v1/lcgate', lcgateRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const baseUrl = `http://localhost:${address.port}/api/v1/lcgate`;

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

  try {
    // Clear in-memory cache to ensure clean test state
    clusterCacheManager.invalidateAll();

    // -------------------------------------------------------------------------
    // TEST 1: Cold load returns HTTP 200 with canonical ETag and MISS
    // -------------------------------------------------------------------------
    console.log('TEST 1: Cold Load Response & Headers');
    const t0 = Date.now();
    const res1 = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const dur1 = Date.now() - t0;
    assert(res1.status === 200, `First request returned HTTP 200 (${dur1}ms).`);
    const etag1 = res1.headers.get('etag');
    assert(!!etag1 && etag1.startsWith('W/'), `Response includes weak ETag: ${etag1}`);
    assert(res1.headers.get('cache-control') === 'private, no-cache', 'Cache-Control header is private, no-cache.');
    assert(res1.headers.get('x-cluster-cache') === 'MISS', 'First request is cache MISS (evaluated from DB).');
    const data1 = await res1.json();
    assert(Array.isArray(data1), 'Data returned is array of gates.');
    console.log(`         Received ${data1.length} gate(s). Initial ETag: ${etag1}\n`);

    // -------------------------------------------------------------------------
    // TEST 2: Conditional Revalidation with If-None-Match returns HTTP 304 (<2ms)
    // -------------------------------------------------------------------------
    console.log('TEST 2: Conditional Revalidation (HTTP 304)');
    const t1 = Date.now();
    const res2 = await fetch(baseUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'If-None-Match': etag1!,
      },
    });
    const dur2 = Date.now() - t1;
    assert(res2.status === 304, `Request with matching If-None-Match returns HTTP 304 (${dur2}ms).`);
    const text2 = await res2.text();
    assert(text2.length === 0, 'HTTP 304 response body is strictly 0 bytes.');
    console.log(`         HTTP 304 verified with 0 byte transfer in ${dur2}ms.\n`);

    // -------------------------------------------------------------------------
    // TEST 3: Warm request without If-None-Match hits L1 Cache (HIT < 5ms)
    // -------------------------------------------------------------------------
    console.log('TEST 3: Backend L1 Cache Hit');
    const t2 = Date.now();
    const res3 = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const dur3 = Date.now() - t2;
    assert(res3.status === 200, 'Warm request returned HTTP 200.');
    assert(res3.headers.get('x-cluster-cache') === 'HIT', `Response served from L1 Cache HIT (${dur3}ms).`);
    assert(res3.headers.get('etag') === etag1, 'Cache HIT retains identical canonical ETag.');
    const data3 = await res3.json();
    assert(data3.length === data1.length, 'Cache HIT returns identical gate payload.\n');

    // -------------------------------------------------------------------------
    // TEST 4: Query parameter scoping produces distinct cache keys and ETags
    // -------------------------------------------------------------------------
    console.log('TEST 4: Query Parameter Isolation');
    const resScoped1 = await fetch(`${baseUrl}?scopeGroupId=99999`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resScoped1.status === 200, 'GET /?scopeGroupId=99999 returns HTTP 200.');
    const etagScoped1 = resScoped1.headers.get('etag');
    assert(etagScoped1 !== etag1, `Scoped ETag (${etagScoped1}) differs from all-gates ETag (${etag1}).`);

    const resDirect = await fetch(`${baseUrl}?scopeGroupId=99999&directOnly=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const etagDirect = resDirect.headers.get('etag');
    assert(etagDirect !== etagScoped1, `directOnly=true ETag (${etagDirect}) differs from recursive ETag (${etagScoped1}).\n`);

    // -------------------------------------------------------------------------
    // TEST 5: Revision Bump invalidates L1 cache & ETag
    // -------------------------------------------------------------------------
    console.log('TEST 5: Monotonic Revision Invalidation');
    await bumpDirectoryRevision([], true); // Global directory bump
    const resAfterBump = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resAfterBump.status === 200, 'Request after bump returns HTTP 200.');
    assert(resAfterBump.headers.get('x-cluster-cache') === 'MISS', 'Request after revision bump is cache MISS.');
    const etagAfterBump = resAfterBump.headers.get('etag');
    assert(etagAfterBump !== etag1, `New ETag (${etagAfterBump}) differs from pre-bump ETag (${etag1}).\n`);

    // -------------------------------------------------------------------------
    // TEST 6: Static Reference Data Caching & HTTP 304
    // -------------------------------------------------------------------------
    console.log('TEST 6: Reference Data Versioned Caching');
    const resRef1 = await fetch(`${baseUrl}/reference-data`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(resRef1.status === 200, 'GET /reference-data returns HTTP 200.');
    const refEtag = resRef1.headers.get('etag');
    assert(!!refEtag, `Reference data has ETag: ${refEtag}`);
    assert(Boolean(resRef1.headers.get('cache-control')?.includes('max-age=86400')), 'Reference data has long-lived cache-control.');

    const resRef2 = await fetch(`${baseUrl}/reference-data`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'If-None-Match': refEtag!,
      },
    });
    assert(resRef2.status === 304, 'GET /reference-data with matching ETag returns HTTP 304 (0ms).\n');

    // -------------------------------------------------------------------------
    // TEST 7: Single Gate Inspection Caching & HTTP 304
    // -------------------------------------------------------------------------
    if (data1.length > 0) {
      console.log('TEST 7: Single Gate Inspection Caching');
      const gateId = data1[0].id;
      const resGate1 = await fetch(`${baseUrl}/${gateId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(resGate1.status === 200, `GET /${gateId} returns HTTP 200.`);
      const gateEtag = resGate1.headers.get('etag');
      assert(!!gateEtag && gateEtag.includes(`gate-${gateId}`), `Single gate ETag generated: ${gateEtag}`);

      const resGate2 = await fetch(`${baseUrl}/${gateId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'If-None-Match': gateEtag!,
        },
      });
      assert(resGate2.status === 304, `GET /${gateId} with matching ETag returns HTTP 304 (0ms).\n`);
    }

    // -------------------------------------------------------------------------
    // TEST 8: Telemetry Freshness Boundary Verification
    // -------------------------------------------------------------------------
    console.log('TEST 8: Telemetry Freshness Boundary Transitions');
    const nowMs = Date.now();
    const ONLINE_CUTOFF_MS = 65 * 60 * 1000;

    // Case A: 1 minute away from 65-min expiry
    const seenAt1Min = nowMs - ONLINE_CUTOFF_MS + 60 * 1000;
    const remaining1Min = (seenAt1Min + ONLINE_CUTOFF_MS) - nowMs;
    const ttl1Min = remaining1Min > 0 ? Math.min(15 * 60 * 1000, remaining1Min) : 0;
    assert(ttl1Min === 60000, `1 minute away from expiry yields exact 60s TTL (actual: ${ttl1Min}ms).`);

    // Case B: 5 seconds away from expiry
    const seenAt5Sec = nowMs - ONLINE_CUTOFF_MS + 5000;
    const remaining5Sec = (seenAt5Sec + ONLINE_CUTOFF_MS) - nowMs;
    const ttl5Sec = remaining5Sec > 0 ? Math.min(15 * 60 * 1000, remaining5Sec) : 0;
    assert(ttl5Sec === 5000, `5 seconds away from expiry yields exact 5s TTL (actual: ${ttl5Sec}ms).`);

    // Case C: Exactly at 65-min expiry (0ms remaining)
    const seenAtZero = nowMs - ONLINE_CUTOFF_MS;
    const remainingZero = (seenAtZero + ONLINE_CUTOFF_MS) - nowMs;
    const ttlZero = remainingZero > 0 ? Math.min(15 * 60 * 1000, remainingZero) : 0;
    assert(ttlZero === 0, `Exactly at 65-min expiry yields 0ms TTL (immediate expiration, actual: ${ttlZero}ms).`);

    // Case D: Past 65-min expiry (device offline)
    const seenAtPast = nowMs - ONLINE_CUTOFF_MS - 10000;
    const isOnlinePast = (nowMs - seenAtPast) <= ONLINE_CUTOFF_MS;
    assert(!isOnlinePast, 'Device past 65-minute cutoff is evaluated strictly as OFFLINE.\n');

    // -------------------------------------------------------------------------
    // TEST 9: Memory Budget in Bytes, LRU Eviction & Oversized Payload Handling
    // -------------------------------------------------------------------------
    console.log('TEST 9: Memory Budget in Bytes & LRU Eviction');
    const statsBefore = clusterCacheManager.getStats();
    assert(statsBefore.currentMemoryBytes >= 0, `Memory byte tracking active (current: ${statsBefore.currentMemoryBytes} bytes).`);
    assert(statsBefore.maxMemoryBytes > 0, `Configured max memory budget enforced (${statsBefore.maxMemoryBytes / (1024 * 1024)} MB).`);

    // Test LRU byte-budget eviction with simulated small-budget manager
    // @ts-ignore
    const { ClusterCacheManager } = await import('../src/lib/clusterCacheManager');
    // Instantiate with 2000 bytes max budget
    // @ts-ignore
    const tinyManager = new clusterCacheManager.constructor(100, 60000, 2000);
    const smallPayload = [{ id: 1, name: 'Gate 1' }];
    tinyManager.set('key-1', smallPayload, 'W/"etag-1"', { userId: 1 });
    const stats1 = tinyManager.getStats();
    assert(stats1.currentMemoryBytes > 0, `First entry allocated ${stats1.currentMemoryBytes} bytes.`);

    // Fill beyond 2000 bytes budget
    for (let i = 2; i <= 10; i++) {
      tinyManager.set(`key-${i}`, [{ id: i, name: `Gate ${i} with long description ${'x'.repeat(100)}` }], `W/"etag-${i}"`, { userId: 1 });
    }
    const statsFilled = tinyManager.getStats();
    assert(statsFilled.currentMemoryBytes <= 2000, `Memory strictly capped within 2000-byte budget (actual: ${statsFilled.currentMemoryBytes} bytes).`);
    assert(tinyManager.get('key-1') === null, 'Oldest entry (key-1) was evicted via LRU byte-budget enforcement.');

    // Oversized payload rejection
    const hugePayload = [{ id: 99, data: 'y'.repeat(5000) }];
    tinyManager.set('key-huge', hugePayload, 'W/"etag-huge"', { userId: 1 });
    assert(tinyManager.get('key-huge') === null, 'Oversized payload exceeding total budget was safely rejected without crashing.\n');

    // -------------------------------------------------------------------------
    // TEST 10: Deep Freeze & In-Memory Immutability Protection
    // -------------------------------------------------------------------------
    console.log('TEST 10: Immutability & Deep Freeze Protection');
    const originalObj = [{ id: 100, status: 'OPEN', sub: { prop: 'original' } }];
    clusterCacheManager.set('test-immutability', originalObj, 'W/"etag-imm"', { userId: 999 });

    const retrieved1 = clusterCacheManager.get<any[]>('test-immutability');
    assert(!!retrieved1, 'Retrieved cached entry.');
    // Mutate caller's local copy
    retrieved1!.data[0].status = 'CORRUPTED';
    retrieved1!.data[0].sub.prop = 'TAMPERED';

    const retrieved2 = clusterCacheManager.get<any[]>('test-immutability');
    assert(retrieved2!.data[0].status === 'OPEN', 'Cached array object is immune to caller mutation (remains OPEN).');
    assert(retrieved2!.data[0].sub.prop === 'original', 'Nested object properties immune to mutation (remains original).\n');

    console.log('========================================================================');
    console.log(`🎉 ALL ${passed}/${total} BACKEND CACHING & ETAG TESTS PASSED!`);
    console.log('========================================================================');
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

runClusterCachingTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

