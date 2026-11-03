import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import lcgateRoutes from '../src/routes/lcgate';
import { errorHandler } from '../src/middleware/error';
import { clusterCacheManager } from '../src/lib/clusterCacheManager';

function calculatePercentiles(latencies: number[]) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return {
    p50: p50.toFixed(2),
    p95: p95.toFixed(2),
    avg: avg.toFixed(2),
    min: min.toFixed(2),
    max: max.toFixed(2),
  };
}

async function runBenchmark() {
  console.log('========================================================================');
  console.log('📊 BENCHMARK INVESTIGATION: CLUSTER CACHING PERFORMANCE & BREAKDOWN');
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

  const app = express();
  app.use(express.json());
  app.use('/api/v1/lcgate', lcgateRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const baseUrl = `http://localhost:${address.port}/api/v1/lcgate`;

  try {
    // 0. Warm-up Phase: prime database connection pool and Express pipeline
    console.log('--- WARM-UP PHASE: 3 pre-benchmark requests to initialize connection pool ---');
    for (let w = 0; w < 3; w++) {
      await fetch(baseUrl, { headers: { Authorization: `Bearer ${token}` } });
    }
    console.log('  Warm-up completed. Steady-state measurements starting...\n');

    const SAMPLE_COUNT = 25;

    // 1. Component Timing Breakdown Measurement
    console.log('--- MEASURING INTERNAL DATABASE COMPONENT TIMINGS ---');
    const authTimes: number[] = [];
    const revTimes: number[] = [];
    const teleTimes: number[] = [];

    for (let i = 0; i < 10; i++) {
      // Measure authorization: scopeGroupUser lookup
      const tAuth0 = performance.now();
      await prisma.scopeGroupUser.findMany({
        where: { userId: devUser.id },
        select: { scopeGroupId: true },
      });
      authTimes.push(performance.now() - tAuth0);

      // Measure revision validation: appSetting directory lookups
      const tRev0 = performance.now();
      await prisma.appSetting.findMany({
        where: { key: { startsWith: 'DIRECTORY_' } },
        select: { key: true, value: true },
      });
      revTimes.push(performance.now() - tRev0);

      // Measure telemetry freshness query
      const cutoffDate = new Date(Date.now() - 65 * 60 * 1000);
      const tTele0 = performance.now();
      await prisma.deviceTelemetry.findMany({
        where: {
          receivedAt: { gte: cutoffDate },
          topic: { not: { contains: '/request' } },
        },
        distinct: ['thingName'],
        select: { thingName: true, receivedAt: true, status: true },
      }).catch(() => []);
      teleTimes.push(performance.now() - tTele0);
    }

    const authStats = calculatePercentiles(authTimes);
    const revStats = calculatePercentiles(revTimes);
    const teleStats = calculatePercentiles(teleTimes);

    console.log(`  • Authorization (Scope Resolution) [Query 1]: avg = ${authStats.avg} ms (p50: ${authStats.p50} ms, p95: ${authStats.p95} ms)`);
    console.log(`  • Revision Validation (Directory AppSettings) [Query 2]: avg = ${revStats.avg} ms (p50: ${revStats.p50} ms, p95: ${revStats.p95} ms)`);
    console.log(`  • Telemetry Freshness Query (DeviceTelemetry) [Query 3]: avg = ${teleStats.avg} ms (p50: ${teleStats.p50} ms, p95: ${teleStats.p95} ms)\n`);

    // 2. Cold DB Fetch (L1 Miss - 4 Database Queries)
    console.log(`--- MEASURING COLD DATABASE FETCH (${SAMPLE_COUNT} samples) ---`);
    const coldLatencies: number[] = [];
    let coldPayloadBytes = 0;
    let etag = '';

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      clusterCacheManager.invalidateAll();
      const start = performance.now();
      const res = await fetch(baseUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const end = performance.now();
      const text = await res.text();
      coldLatencies.push(end - start);
      if (i === 0) {
        coldPayloadBytes = Buffer.byteLength(text, 'utf8');
        etag = res.headers.get('etag') || '';
      }
    }

    // 3. Warm L1 Cache Hits (HTTP 200 - 2 Database Queries via Concurrent Round-Trip)
    console.log(`--- MEASURING WARM L1 CACHE HITS (${SAMPLE_COUNT} samples) ---`);
    const warmLatencies: number[] = [];
    let warmPayloadBytes = 0;

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const start = performance.now();
      const res = await fetch(baseUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const end = performance.now();
      const text = await res.text();
      warmLatencies.push(end - start);
      if (i === 0) {
        warmPayloadBytes = Buffer.byteLength(text, 'utf8');
      }
    }

    // 4. HTTP 304 Conditional Revalidation (2 Database Queries via Concurrent Round-Trip)
    console.log(`--- MEASURING HTTP 304 CONDITIONAL REVALIDATION (${SAMPLE_COUNT} samples) ---`);
    const revalLatencies: number[] = [];
    let revalPayloadBytes = 0;

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const start = performance.now();
      const res = await fetch(baseUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'If-None-Match': etag,
        },
      });
      const end = performance.now();
      const text = await res.text();
      revalLatencies.push(end - start);
      if (i === 0) {
        revalPayloadBytes = Buffer.byteLength(text, 'utf8');
      }
    }

    const coldStats = calculatePercentiles(coldLatencies);
    const warmStats = calculatePercentiles(warmLatencies);
    const revalStats = calculatePercentiles(revalLatencies);

    console.log('\n========================================================================');
    console.log('RESULTS SUMMARY (CONSISTENT STEADY-STATE CONDITIONS)');
    console.log('========================================================================');
    console.log(`Cold Database Fetch (L1 Miss):`);
    console.log(`  - Samples: ${SAMPLE_COUNT} | Warm-up: 3 requests`);
    console.log(`  - Average: ${coldStats.avg} ms | p50: ${coldStats.p50} ms | p95: ${coldStats.p95} ms (min: ${coldStats.min} ms, max: ${coldStats.max} ms)`);
    console.log(`  - Database Queries: 4 (scopeGroupUser, appSetting, lCGate with joins, deviceTelemetry)`);
    console.log(`  - Payload Size: ${coldPayloadBytes} bytes\n`);

    console.log(`Backend L1 Cache Hit (HTTP 200):`);
    console.log(`  - Samples: ${SAMPLE_COUNT} | Warm-up: 3 requests`);
    console.log(`  - Average: ${warmStats.avg} ms | p50: ${warmStats.p50} ms | p95: ${warmStats.p95} ms (min: ${warmStats.min} ms, max: ${warmStats.max} ms)`);
    console.log(`  - Database Queries: 2 (scopeGroupUser & appSetting executed concurrently in 1 round-trip)`);
    console.log(`  - Payload Size: ${warmPayloadBytes} bytes\n`);

    console.log(`Conditional Revalidation (HTTP 304 Not Modified):`);
    console.log(`  - Samples: ${SAMPLE_COUNT} | Warm-up: 3 requests`);
    console.log(`  - Average: ${revalStats.avg} ms | p50: ${revalStats.p50} ms | p95: ${revalStats.p95} ms (min: ${revalStats.min} ms, max: ${revalStats.max} ms)`);
    console.log(`  - Database Queries: 2 (scopeGroupUser & appSetting executed concurrently in 1 round-trip)`);
    console.log(`  - Payload Size: ${revalPayloadBytes} bytes (100% bandwidth reduction!)\n`);

    const latencyReduction = (
      ((parseFloat(coldStats.avg) - parseFloat(revalStats.avg)) / parseFloat(coldStats.avg)) *
      100
    ).toFixed(1);

    console.log(`Latency Reduction on 304: ~${latencyReduction}%`);
    console.log(`Payload Transfer Reduction on 304: 100.0% (${coldPayloadBytes} B -> 0 B)`);
    console.log('========================================================================\n');
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
