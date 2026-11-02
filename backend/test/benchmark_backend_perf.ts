import { performance } from 'perf_hooks';
import { prisma } from '../src/lib/prisma';
import { generateReportETag, getLatestGateRevisions, calculateAuthoritativeMetrics } from '../src/lib/reportRevisionManager';

async function measureBackendPerf() {
  console.log('========================================================================');
  console.log('⚡ BACKEND PROCESSING DURATION BENCHMARK');
  console.log('========================================================================\n');

  const gates = await prisma.lCGate.findMany({ take: 5, select: { id: true } });
  const gateIds = gates.map(g => g.id);
  const userId = 1;
  const canonicalParams = 'g:all|s:2026-10-25|e:2026-11-01|st:ALL|sh:ALL';

  // 1. Measure generateReportETag duration (100 iterations)
  const etagIters = 100;
  const t0 = performance.now();
  for (let i = 0; i < etagIters; i++) {
    await generateReportETag(userId, gateIds, [], canonicalParams);
  }
  const avgETagTime = (performance.now() - t0) / etagIters;

  // 2. Measure getLatestGateRevisions duration (100 iterations)
  const revIters = 100;
  const t1 = performance.now();
  for (let i = 0; i < revIters; i++) {
    await getLatestGateRevisions(gateIds);
  }
  const avgRevTime = (performance.now() - t1) / revIters;

  // 3. Measure calculateAuthoritativeMetrics duration (20 iterations)
  const kpiIters = 20;
  const t2 = performance.now();
  for (let i = 0; i < kpiIters; i++) {
    await calculateAuthoritativeMetrics(gateIds, '2026-10-25', '2026-11-01');
  }
  const avgKpiTime = (performance.now() - t2) / kpiIters;

  console.log(`1. Backend ETag Generation Duration:        ${avgETagTime.toFixed(3)} ms`);
  console.log(`2. Backend Gate Revisions Fetch Duration:   ${avgRevTime.toFixed(3)} ms`);
  console.log(`3. Authoritative Metrics DB Computation:    ${avgKpiTime.toFixed(3)} ms`);
  console.log('========================================================================\n');

  await prisma.$disconnect();
}

measureBackendPerf();
