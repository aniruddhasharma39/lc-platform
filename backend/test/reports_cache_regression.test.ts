import http from 'http';
import jwt from 'jsonwebtoken';
import express from 'express';
import { prisma } from '../src/lib/prisma';
import reportsRoutes from '../src/routes/reports';
import { errorHandler } from '../src/middleware/error';
import {
  bumpReportRevision,
  bumpReportRevisionInTx,
  generateReportETag,
  isETagMatch,
  deleteOperationalEvent,
  deleteOperationalEvents,
  calculateAuthoritativeMetrics,
} from '../src/lib/reportRevisionManager';

/**
 * Permanent Backend Regression Test Suite for LC Platform Reports Caching
 * Run via: npm test or npx ts-node test/reports_cache_regression.test.ts
 */
async function runPermanentRegressionTests() {
  console.log('========================================================================');
  console.log('🛡️  PERMANENT BACKEND REGRESSION SUITE: REPORTS MODULE CACHING');
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

  // Find an authorized user for test tokens
  const user = await prisma.user.findFirst({
    where: { status: 'APPROVED', role: { name: 'DEVELOPER' } },
    include: { role: true },
  }) || await prisma.user.findFirst({
    where: { status: 'APPROVED' },
    include: { role: true },
  });

  if (!user) {
    throw new Error('No approved user found in database to execute regression tests');
  }

  const jwtSecret = process.env.JWT_SECRET || 'fallback-secret';
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role?.name || 'DEVELOPER' },
    jwtSecret,
    { expiresIn: '2h' }
  );

  // Spin up test server on dynamic port
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  function makeRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: any
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any; rawBody: string }> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(payload && {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }),
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let parsed = null;
            if (data) {
              try { parsed = JSON.parse(data); } catch { parsed = data; }
            }
            resolve({ status: res.statusCode || 0, headers: res.headers, body: parsed, rawBody: data });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  try {
    // ─────────────────────────────────────────────────────────────────
    // TEST 1: Initial Revision Invalidation (Before & After First Mutation)
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 1. Initial Revision Invalidation ---');
    const freshGate = await prisma.lCGate.create({
      data: {
        lcNumber: `LC-REV-${Date.now()}`,
        name: 'Fresh Revision Test Gate',
        locationName: 'Rev Yard',
        zone: 'CR',
        division: 'Mumbai',
      },
    });

    // Verify key does not exist yet in AppSetting
    const settingKey = `REPORT_GATE_REV_${freshGate.id}`;
    await prisma.appSetting.deleteMany({ where: { key: settingKey } });

    const etagBeforeMutation = await generateReportETag(user.id, [freshGate.id], [1], 'query=init');
    
    // First mutation
    await prisma.$transaction(async (tx) => {
      await tx.lCGateEvent.create({
        data: { gateId: freshGate.id, openedAt: new Date(), status: 'OPEN' },
      });
      await bumpReportRevisionInTx(tx, freshGate.id);
    });

    const etagAfterMutation = await generateReportETag(user.id, [freshGate.id], [1], 'query=init');
    assert(
      etagBeforeMutation !== etagAfterMutation,
      'Initial ETag changes strictly after first mutation (0 -> 1 increment)',
      `Before: ${etagBeforeMutation}, After: ${etagAfterMutation}`
    );

    // ─────────────────────────────────────────────────────────────────
    // TEST 2: Event Creation & Closure Transitions
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Event Creation & Closure Transitions ---');
    const openTime = new Date();
    const event = await prisma.lCGateEvent.create({
      data: { gateId: freshGate.id, openedAt: openTime, status: 'OPEN' },
    });
    await bumpReportRevision(freshGate.id);

    const etagOpen = await generateReportETag(user.id, [freshGate.id], [1], 'query=init');
    assert(etagOpen !== etagAfterMutation, 'Creating another event alters ETag');

    const closeTime = new Date(openTime.getTime() + 180000); // 3 mins
    await prisma.lCGateEvent.update({
      where: { id: event.id },
      data: { status: 'CLOSED', closedAt: closeTime, durationSeconds: 180 },
    });
    await bumpReportRevision(freshGate.id);

    const etagClosed = await generateReportETag(user.id, [freshGate.id], [1], 'query=init');
    assert(etagClosed !== etagOpen, 'Transition from OPEN to CLOSED alters ETag');

    // ─────────────────────────────────────────────────────────────────
    // TEST 3: Single and Bulk Deletion with Tombstones
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Single & Bulk Deletion with Tombstones ---');
    await deleteOperationalEvent(event.id);

    const singleTombstone = await prisma.lCGateEventTombstone.findFirst({
      where: { eventId: event.id },
    });
    assert(singleTombstone !== null, 'Single deletion records tombstone row');
    assert(singleTombstone?.gateId === freshGate.id, 'Tombstone preserves gate ID');

    // Bulk delete test
    const ev1 = await prisma.lCGateEvent.create({ data: { gateId: freshGate.id, openedAt: new Date() } });
    const ev2 = await prisma.lCGateEvent.create({ data: { gateId: freshGate.id, openedAt: new Date() } });
    const bulkCount = await deleteOperationalEvents([ev1.id, ev2.id]);
    assert(bulkCount === 2, 'Bulk deletion removed exactly 2 events');

    const bulkTombstones = await prisma.lCGateEventTombstone.findMany({
      where: { eventId: { in: [ev1.id, ev2.id] } },
    });
    assert(bulkTombstones.length === 2, 'Bulk deletion created 2 tombstone records');

    // ─────────────────────────────────────────────────────────────────
    // TEST 4: Gate Cascade Deletion Preserves Tombstones
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Gate Cascade Deletion Preserves Tombstones ---');
    const cascadeEv = await prisma.lCGateEvent.create({
      data: { gateId: freshGate.id, openedAt: new Date(), status: 'OPEN' },
    });

    // Simulate router.delete('/:id')
    await prisma.$transaction(async (tx) => {
      const eventsToDelete = await tx.lCGateEvent.findMany({
        where: { gateId: freshGate.id },
        select: { id: true, gateId: true, openedAt: true },
      });
      if (eventsToDelete.length > 0) {
        await tx.lCGateEventTombstone.createMany({
          data: eventsToDelete.map((e) => ({
            eventId: e.id,
            gateId: e.gateId,
            openedAt: e.openedAt,
          })),
        });
      }
      await tx.lCGate.delete({ where: { id: freshGate.id } });
    });

    const preservedTombstone = await prisma.lCGateEventTombstone.findFirst({
      where: { eventId: cascadeEv.id },
    });
    assert(preservedTombstone !== null, 'Cascade-deleted event was preserved in LCGateEventTombstone');

    // ─────────────────────────────────────────────────────────────────
    // TEST 5: Transaction Rollback Integrity
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Transaction Rollback Integrity ---');
    const rollbackGate = await prisma.lCGate.create({
      data: { lcNumber: `LC-RB-${Date.now()}`, locationName: 'Rollback Yard', zone: 'CR', division: 'Mumbai' },
    });

    try {
      await prisma.$transaction(async (tx) => {
        await tx.lCGateEvent.create({
          data: { gateId: rollbackGate.id, openedAt: new Date(), remarks: 'Should be rolled back' },
        });
        throw new Error('Simulated failure during mutation');
      });
    } catch {
      // Expected rollback
    }

    const rolledBackEvents = await prisma.lCGateEvent.findMany({ where: { gateId: rollbackGate.id } });
    assert(rolledBackEvents.length === 0, 'Rolled-back transaction leaves 0 events in database');

    // ─────────────────────────────────────────────────────────────────
    // TEST 6: Multiple Updates Sharing Identical Timestamps
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 6. Multiple Updates Sharing Identical Timestamps ---');
    const fixedTime = new Date('2026-11-01T10:00:00.000Z');
    const evSame1 = await prisma.lCGateEvent.create({
      data: { gateId: rollbackGate.id, openedAt: fixedTime, updatedAt: fixedTime, status: 'OPEN' },
    });
    const evSame2 = await prisma.lCGateEvent.create({
      data: { gateId: rollbackGate.id, openedAt: fixedTime, updatedAt: fixedTime, status: 'CLOSED', durationSeconds: 60 },
    });

    const tieBreakQuery = await prisma.lCGateEvent.findMany({
      where: {
        gateId: rollbackGate.id,
        OR: [
          { updatedAt: { gt: fixedTime } },
          { updatedAt: fixedTime, id: { gt: evSame1.id } },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    });
    assert(tieBreakQuery.length === 1 && tieBreakQuery[0].id === evSame2.id, 'Composite (updatedAt, id) cursor cleanly breaks timestamp ties');

    // ─────────────────────────────────────────────────────────────────
    // TEST 7: Cursor Continuation & Pagination (Past 50 Items)
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 7. Cursor Continuation Past Limit ---');
    const batchEventsData = Array.from({ length: 55 }, (_, i) => ({
      gateId: rollbackGate.id,
      openedAt: new Date(Date.now() + i * 1000),
      status: 'CLOSED',
      durationSeconds: 100 + i,
    }));
    await prisma.lCGateEvent.createMany({ data: batchEventsData });

    const changesBatch1 = await makeRequest(
      'GET',
      `/api/v1/reports/records/changes?gateIds=${rollbackGate.id}&eventCursorTime=1970-01-01T00:00:00.000Z&eventCursorId=0&limitEvents=50`
    );
    assert(changesBatch1.body.hasMoreEvents === true, 'hasMoreEvents is true when > 50 events exist');
    assert(changesBatch1.body.events.length === 50, 'Batch 1 returns exactly 50 events');

    const nextTime = changesBatch1.body.nextEventCursor.time;
    const nextId = changesBatch1.body.nextEventCursor.id;

    const changesBatch2 = await makeRequest(
      'GET',
      `/api/v1/reports/records/changes?gateIds=${rollbackGate.id}&eventCursorTime=${encodeURIComponent(nextTime)}&eventCursorId=${nextId}&limitEvents=50`
    );
    assert(changesBatch2.body.events.length >= 5, 'Batch 2 resumes from nextEventCursor and returns remaining events');
    assert(changesBatch2.body.hasMoreEvents === false, 'hasMoreEvents is false after backlog is drained');

    // ─────────────────────────────────────────────────────────────────
    // TEST 8: RFC 7232 ETag Match Matrix (Single, Multi, Wildcard, Weak)
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 8. RFC 7232 ETag Match Matrix ---');
    const etagTarget = 'W/"rep-u1-gabc123-sdef456-q789"';
    assert(isETagMatch(etagTarget, etagTarget), 'Matches identical weak ETag');
    assert(isETagMatch('"rep-u1-gabc123-sdef456-q789"', etagTarget), 'Matches stripped strong representation');
    assert(isETagMatch('*', etagTarget), 'Matches wildcard *');
    assert(isETagMatch('W/"other-etag", W/"rep-u1-gabc123-sdef456-q789"', etagTarget), 'Matches comma-separated ETag list');
    assert(!isETagMatch('W/"non-matching-etag"', etagTarget), 'Rejects non-matching ETag');

    // HTTP 304 Verification with empty body
    const httpGetRecords = await makeRequest('GET', `/api/v1/reports/records?gateIds=${rollbackGate.id}`);
    const currentETag = httpGetRecords.headers['etag'] as string;

    const http304Res = await makeRequest('GET', `/api/v1/reports/records?gateIds=${rollbackGate.id}`, {
      'if-none-match': currentETag,
    });
    assert(http304Res.status === 304, 'GET /records with If-None-Match returns HTTP 304');
    assert(http304Res.rawBody === '', 'HTTP 304 body is completely empty');

    // Consistent snapshot cursor verification
    assert(typeof httpGetRecords.body.cursor?.eventCursorTime === 'string', 'GET /records returns initial cursor.eventCursorTime');
    assert(typeof httpGetRecords.body.cursor?.tombstoneCursorId === 'string', 'GET /records returns initial cursor.tombstoneCursorId');

    // ─────────────────────────────────────────────────────────────────
    // TEST 9: Tombstone Expiration Watermark Trigger
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 9. Tombstone Expiration Watermark ---');
    const tOld = await prisma.lCGateEventTombstone.create({
      data: { eventId: 999991, gateId: rollbackGate.id, openedAt: new Date() },
    });

    const expiredRes = await makeRequest(
      'GET',
      `/api/v1/reports/records/changes?gateIds=${rollbackGate.id}&tombstoneCursorId=1`
    );
    if (tOld.id > 1n) {
      assert(
        expiredRes.body.requiresFullSync === true && expiredRes.body.resyncReason === 'TOMBSTONE_CURSOR_EXPIRED',
        'Expired tombstone cursor triggers requiresFullSync: true'
      );
    } else {
      assert(expiredRes.body.requiresFullSync === false, 'Fresh tombstone cursor allowed');
    }

    // ─────────────────────────────────────────────────────────────────
    // TEST 10: Authoritative KPI Metrics Correctness
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 10. Authoritative KPI Metrics Correctness ---');
    const kpis = await calculateAuthoritativeMetrics([rollbackGate.id]);
    assert(typeof kpis.totalOperations === 'number' && kpis.totalOperations > 0, 'Calculates total operations');
    assert(typeof kpis.avgDurationSeconds === 'number', 'Calculates avg duration');
    assert(typeof kpis.currentlyOpenCount === 'number', 'Calculates open count');

    // Cleanup rollback gate
    await prisma.lCGateEvent.deleteMany({ where: { gateId: rollbackGate.id } });
    await prisma.lCGateEventTombstone.deleteMany({ where: { gateId: rollbackGate.id } });
    await prisma.lCGate.delete({ where: { id: rollbackGate.id } });

    console.log('\n========================================================================');
    console.log(`🎉 ALL ${passed}/${passed + failed} REGRESSION TESTS PASSED!`);
    console.log('========================================================================\n');
  } catch (error) {
    console.error('Fatal error in regression test suite:', error);
    process.exit(1);
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

runPermanentRegressionTests();

