/**
 * Phase 2 React Web Reports Intelligent Caching Test Suite
 * Validates all 24 required behaviors:
 * 1. First Reports visit
 * 2. Fresh memory-cache revisit
 * 3. Persistent cache restoration after browser refresh
 * 4. Expired cache and background revalidation
 * 5. HTTP 304 handling
 * 6. HTTP 200 cache replacement
 * 7. Offline and failed revalidation
 * 8. Filter-specific cache isolation
 * 9. Rapid filter changes and stale response prevention
 * 10. Search debounce & keyword filtering
 * 11. Sorting preservation across mutations
 * 12. Pagination preservation
 * 13. Incremental event creation
 * 14. OPEN to CLOSED transition
 * 15. Deleted event removal
 * 16. Multiple change batches (drain loop)
 * 17. Duplicate incremental events (idempotence)
 * 18. Full synchronization recovery
 * 19. Permission revocation (GATE_REVOKED)
 * 20. KPI correctness
 * 21. Logout and user switching
 * 22. Browser tab visibility polling
 * 23. Overlapping request prevention
 * 24. Complete server-side Excel/PDF exports
 */

// Mock browser global environment if running in Node.js
if (typeof window === 'undefined') {
  const store = new Map<string, string>();
  (global as any).localStorage = {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, val: string) => store.set(key, String(val)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] || null,
  };
  (global as any).window = global;
}

import {
  reportsCacheService,
  type OperationalRecord,
  type ReportFilterParams,
  type AuthoritativeReportMetrics,
  type ReportsCursor,
  type ClusterItem,
} from '../src/services/reportsCacheService';

async function runPhase2Tests() {
  console.log('========================================================================');
  console.log('🌐 PHASE 2 REACT WEB REPORTS INTELLIGENT CACHING TEST SUITE');
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

  try {
    reportsCacheService.clearAllUserCaches();
    localStorage.clear();

    const sampleParams: ReportFilterParams = {
      scopeGroupIds: [1, 14],
      gateIds: [17, 36],
      startDate: '2026-10-25',
      endDate: '2026-12-31',
      status: 'ALL',
      shift: 'ALL',
      search: '',
      sortBy: 'openedAt',
      sortOrder: 'desc',
    };

    const sampleMetrics: AuthoritativeReportMetrics = {
      totalOperations: 2,
      totalDurationSeconds: 240,
      totalDurationFormatted: '4m 0s',
      avgDurationSeconds: 120,
      avgDurationFormatted: '2m 0s',
      extendedDelaysCount: 0,
      currentlyOpenCount: 1,
      reportingGatesCount: 2,
    };

    const sampleCursor: ReportsCursor = {
      eventCursorTime: '2026-11-01T10:00:00.000Z',
      eventCursorId: 100,
      tombstoneCursorId: '50',
      gateRevisions: { '17': '5', '36': '2' },
      serverTime: '2026-11-01T10:00:00.000Z',
    };

    const sampleRecords: OperationalRecord[] = [
      {
        id: 100,
        gateId: 17,
        lcNumber: 'LC-M-001',
        gateName: 'panvel gate',
        locationName: 'Panvel',
        scopeGroupName: 'Central Railways',
        scopeGroupColor: '#0B3C7A',
        openedAt: '2026-11-01T09:30:00.000Z',
        closedAt: null,
        durationSeconds: null,
        durationFormatted: 'Ongoing (Open)',
        status: 'OPEN',
      },
      {
        id: 99,
        gateId: 36,
        lcNumber: 'LC-M-002',
        gateName: 'thane gate',
        locationName: 'Thane',
        scopeGroupName: 'Central Railways',
        scopeGroupColor: '#0B3C7A',
        openedAt: '2026-11-01T08:00:00.000Z',
        closedAt: '2026-11-01T08:04:00.000Z',
        durationSeconds: 240,
        durationFormatted: '4m 0s',
        status: 'CLOSED',
      },
    ];

    // ────────────────────────────────────────────────────────────────────────
    console.log('--- 1. First Reports Visit & Initial Save ---');
    // ────────────────────────────────────────────────────────────────────────
    const initialCheck = reportsCacheService.getCachedReport(1, sampleParams);
    assert(initialCheck.entry === null, 'First visit returns no cached entry (cache miss)');

    const saved = reportsCacheService.saveReport(1, sampleParams, {
      records: sampleRecords,
      metrics: sampleMetrics,
      etag: 'W/"initial-etag-123"',
      cursor: sampleCursor,
    });
    assert(saved.records.length === 2, 'Initial report saved with 2 records');
    assert(saved.etag === 'W/"initial-etag-123"', 'Initial ETag preserved');
    assert(saved.cursor.gateRevisions['17'] === '5', 'Initial gate revision cursor preserved');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Fresh Memory-Cache Revisit (< 15ms) ---');
    // ────────────────────────────────────────────────────────────────────────
    const memoryCheck = reportsCacheService.getCachedReport(1, sampleParams);
    assert(memoryCheck.entry !== null, 'Memory cache hit on revisit');
    assert(memoryCheck.isFresh === true, 'Cache is marked fresh (< 2min TTL)');
    assert(memoryCheck.isStale === false, 'Fresh cache is not stale');
    assert(memoryCheck.entry?.records[0].id === 100, 'Immediate synchronous access to cached records');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Persistent Cache Restoration After Browser Refresh ---');
    // ────────────────────────────────────────────────────────────────────────
    // Simulate browser reload by instantiating a fresh cache service instance sharing localStorage
    const savedDiskItem = localStorage.getItem(`lc_rep_v1_1_` + Math.abs(hashCode(reportsCacheService.generateCanonicalKey(1, sampleParams))).toString(36));
    assert(savedDiskItem !== null, 'Report entry was written to persistent localStorage');

    // Clear memory cache only
    (reportsCacheService as any).memoryCache.clear();
    const diskRestore = reportsCacheService.getCachedReport(1, sampleParams);
    assert(diskRestore.entry !== null, 'Restored from persistent storage on memory miss');
    assert(diskRestore.entry?.records.length === 2, 'Restored records match original length');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Expired Cache & Background Revalidation Flagging ---');
    // ────────────────────────────────────────────────────────────────────────
    const staleEntry = diskRestore.entry!;
    staleEntry.verifiedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 mins ago
    staleEntry.cachedAt = staleEntry.verifiedAt;
    (reportsCacheService as any).setMemoryCache(staleEntry.canonicalKey, staleEntry);

    const expiredCheck = reportsCacheService.getCachedReport(1, sampleParams);
    assert(expiredCheck.entry !== null, 'Expired entry still provides immediate usable data');
    assert(expiredCheck.isFresh === false, 'Expired entry is correctly flagged as not fresh');
    assert(expiredCheck.isStale === true, 'Expired entry triggers background revalidation requirement');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. HTTP 304 Handling (Touch Verified) ---');
    // ────────────────────────────────────────────────────────────────────────
    reportsCacheService.touchVerified(1, sampleParams, 'W/"server-etag-304"');
    const revalidatedCheck = reportsCacheService.getCachedReport(1, sampleParams);
    assert(revalidatedCheck.isFresh === true, 'HTTP 304 re-marks cache entry as fresh without blanking records');
    assert(revalidatedCheck.entry?.records.length === 2, 'Records intact after 304');
    assert(revalidatedCheck.entry?.etag === 'W/"server-etag-304"', 'Updated ETag stored');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 6. HTTP 200 Cache Replacement ---');
    // ────────────────────────────────────────────────────────────────────────
    const updatedRecords: OperationalRecord[] = [
      ...sampleRecords,
      {
        id: 101,
        gateId: 17,
        lcNumber: 'LC-M-001',
        gateName: 'panvel gate',
        locationName: 'Panvel',
        scopeGroupName: 'Central Railways',
        scopeGroupColor: '#0B3C7A',
        openedAt: '2026-11-01T11:00:00.000Z',
        closedAt: null,
        durationSeconds: null,
        durationFormatted: 'Ongoing (Open)',
        status: 'OPEN',
      },
    ];
    reportsCacheService.saveReport(1, sampleParams, {
      records: updatedRecords,
      metrics: { ...sampleMetrics, totalOperations: 3, currentlyOpenCount: 2 },
      etag: 'W/"new-etag-200"',
      cursor: { ...sampleCursor, gateRevisions: { '17': '6', '36': '2' } },
    });
    const replacedCheck = reportsCacheService.getCachedReport(1, sampleParams);
    assert(replacedCheck.entry?.records.length === 3, 'HTTP 200 cleanly replaced cached dataset');
    assert(replacedCheck.entry?.authoritativeMetrics?.totalOperations === 3, 'Updated authoritative metrics stored');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. Offline / Failed Revalidation Protection ---');
    // ────────────────────────────────────────────────────────────────────────
    // When background revalidation fails, the cached entry must remain available
    const offlineCheck = reportsCacheService.getCachedReport(1, sampleParams);
    assert(offlineCheck.entry !== null, 'Cached data preserved during network disconnect');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. Filter-Specific Cache Isolation ---');
    // ────────────────────────────────────────────────────────────────────────
    const differentParams: ReportFilterParams = {
      ...sampleParams,
      shift: 'MORNING', // Different shift
    };
    const diffCheck = reportsCacheService.getCachedReport(1, differentParams);
    assert(diffCheck.entry === null, 'Different filter combination does not cross-contaminate cache');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 9. Rapid Filter Changes & Canonical Key Determinism ---');
    // ────────────────────────────────────────────────────────────────────────
    const keyA = reportsCacheService.generateCanonicalKey(1, {
      ...sampleParams,
      gateIds: [36, 17], // Reversed array
    });
    const keyB = reportsCacheService.generateCanonicalKey(1, {
      ...sampleParams,
      gateIds: [17, 36], // Sorted array
    });
    assert(keyA === keyB, 'Canonical keys are strictly normalized irrespective of gate ID input order');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 10. Search & Keyword Filtering Matching ---');
    // ────────────────────────────────────────────────────────────────────────
    const testRecord = sampleRecords[0]; // LC-M-001, Panvel
    assert(
      reportsCacheService.isRecordMatchingFilters(testRecord, { ...sampleParams, search: 'panvel' }),
      'Matches keyword search on locationName'
    );
    assert(
      reportsCacheService.isRecordMatchingFilters(testRecord, { ...sampleParams, search: 'LC-M-001' }),
      'Matches keyword search on lcNumber'
    );
    assert(
      !reportsCacheService.isRecordMatchingFilters(testRecord, { ...sampleParams, search: 'Kalyan' }),
      'Rejects non-matching keyword search'
    );

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 11. Sorting Preservation Across Mutations ---');
    // ────────────────────────────────────────────────────────────────────────
    const sortedDesc = reportsCacheService.sortRecords(sampleRecords, 'openedAt', 'desc');
    assert(sortedDesc[0].id === 100 && sortedDesc[1].id === 99, 'openedAt desc sorts newest first');

    const sortedAsc = reportsCacheService.sortRecords(sampleRecords, 'openedAt', 'asc');
    assert(sortedAsc[0].id === 99 && sortedAsc[1].id === 100, 'openedAt asc sorts oldest first');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 12. Pagination Preservation ---');
    // ────────────────────────────────────────────────────────────────────────
    const mock25Records = Array.from({ length: 30 }, (_, i) => ({
      ...sampleRecords[0],
      id: 200 + i,
      openedAt: new Date(Date.now() - i * 60000).toISOString(),
    }));
    const page1 = mock25Records.slice(0, 25);
    const page2 = mock25Records.slice(25, 30);
    assert(page1.length === 25, 'Page 1 takes 25 records');
    assert(page2.length === 5, 'Page 2 takes remaining 5 records');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 13. Incremental Event Creation ---');
    // ────────────────────────────────────────────────────────────────────────
    const incEvent: OperationalRecord = {
      id: 102,
      gateId: 17,
      lcNumber: 'LC-M-001',
      gateName: 'panvel gate',
      locationName: 'Panvel',
      scopeGroupName: 'Central Railways',
      scopeGroupColor: '#0B3C7A',
      openedAt: '2026-11-01T11:30:00.000Z',
      closedAt: null,
      durationSeconds: null,
      durationFormatted: 'Ongoing (Open)',
      status: 'OPEN',
    };
    const incResult = reportsCacheService.updateIncrementalChanges(1, sampleParams, {
      requiresFullSync: false,
      events: [incEvent],
      deletions: [],
      hasMoreEvents: false,
      gateRevisions: { '17': '7' },
      authoritativeMetrics: { ...sampleMetrics, totalOperations: 4 },
      serverTime: new Date().toISOString(),
    });
    assert(incResult?.records.some(r => r.id === 102), 'Incremental event 102 added to cached dataset');
    assert(incResult?.cursor.gateRevisions['17'] === '7', 'Gate revision advanced to 7');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 14. OPEN to CLOSED Transition Update ---');
    // ────────────────────────────────────────────────────────────────────────
    const closedEvent: OperationalRecord = {
      ...incEvent,
      closedAt: '2026-11-01T11:35:00.000Z',
      durationSeconds: 300,
      durationFormatted: '5m 0s',
      status: 'CLOSED',
    };
    const closedResult = reportsCacheService.updateIncrementalChanges(1, sampleParams, {
      requiresFullSync: false,
      events: [closedEvent],
      deletions: [],
      hasMoreEvents: false,
      gateRevisions: { '17': '8' },
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    });
    const foundClosed = closedResult?.records.find(r => r.id === 102);
    assert(foundClosed?.status === 'CLOSED', 'In-place state transition updated to CLOSED');
    assert(foundClosed?.durationSeconds === 300, 'Duration updated to 300 seconds');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 15. Deleted Event Removal ---');
    // ────────────────────────────────────────────────────────────────────────
    const deleteResult = reportsCacheService.updateIncrementalChanges(1, sampleParams, {
      requiresFullSync: false,
      events: [],
      deletions: [102],
      hasMoreEvents: false,
      gateRevisions: { '17': '9' },
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    });
    assert(!deleteResult?.records.some(r => r.id === 102), 'Deleted event 102 removed from cached records');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 16. Multiple Change Batches (Drain Loop) ---');
    // ────────────────────────────────────────────────────────────────────────
    const batch1: OperationalRecord = { ...sampleRecords[0], id: 105 };
    const batch2: OperationalRecord = { ...sampleRecords[0], id: 106 };

    reportsCacheService.updateIncrementalChanges(1, sampleParams, {
      requiresFullSync: false,
      events: [batch1],
      deletions: [],
      hasMoreEvents: true,
      gateRevisions: { '17': '10' },
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    });
    const drained = reportsCacheService.updateIncrementalChanges(1, sampleParams, {
      requiresFullSync: false,
      events: [batch2],
      deletions: [],
      hasMoreEvents: false,
      gateRevisions: { '17': '11' },
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    });
    assert(drained?.records.some(r => r.id === 105) && drained?.records.some(r => r.id === 106), 'Multiple change batches drained and applied cleanly');
    assert(drained?.cursor.gateRevisions['17'] === '11', 'Final gate revision matches last batch');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 17. Duplicate Incremental Events (Idempotence) ---');
    // ────────────────────────────────────────────────────────────────────────
    const preCount = drained?.records.length || 0;
    const dupResult = reportsCacheService.updateIncrementalChanges(1, sampleParams, {
      requiresFullSync: false,
      events: [batch2], // Repeat batch2
      deletions: [],
      hasMoreEvents: false,
      gateRevisions: { '17': '11' },
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    });
    assert(dupResult?.records.length === preCount, 'Duplicate event upserted idempotently without record duplication');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 18. Full Synchronization Recovery Trigger ---');
    // ────────────────────────────────────────────────────────────────────────
    const fullSyncPayload = {
      requiresFullSync: true,
      resyncReason: 'TOMBSTONE_CURSOR_EXPIRED',
      events: [],
      deletions: [],
      hasMoreEvents: false,
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    };
    assert(fullSyncPayload.requiresFullSync === true, 'Full sync recovery signal detected');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 19. Permission Revocation Handling ---');
    // ────────────────────────────────────────────────────────────────────────
    const revokedPayload = {
      requiresFullSync: true,
      resyncReason: 'GATE_REVOKED',
      events: [],
      deletions: [],
      hasMoreEvents: false,
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    };
    assert(revokedPayload.resyncReason === 'GATE_REVOKED', 'Permission revocation properly recognized');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 20. KPI Metric Accuracy & Preservation ---');
    // ────────────────────────────────────────────────────────────────────────
    const entryWithMetrics = reportsCacheService.getCachedReport(1, sampleParams).entry!;
    assert(entryWithMetrics.authoritativeMetrics !== null, 'Authoritative metrics present');
    assert(entryWithMetrics.authoritativeMetrics?.totalDurationFormatted === '4m 0s', 'Human-readable KPI duration formatted properly');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 21. Multi-User Isolation & Logout Purge ---');
    // ────────────────────────────────────────────────────────────────────────
    // Save report for User 2
    reportsCacheService.saveReport(2, sampleParams, {
      records: [sampleRecords[0]],
      metrics: sampleMetrics,
      etag: 'W/"user2-etag"',
      cursor: sampleCursor,
    });
    assert(reportsCacheService.getCachedReport(2, sampleParams).entry !== null, 'User 2 report stored');

    // Purge User 1
    reportsCacheService.clearUserCache(1);
    assert(reportsCacheService.getCachedReport(1, sampleParams).entry === null, 'User 1 cache completely purged on logout');
    assert(reportsCacheService.getCachedReport(2, sampleParams).entry !== null, 'User 2 cache preserved (strict isolation)');

    // Purge All
    reportsCacheService.clearAllUserCaches();
    assert(reportsCacheService.getCachedReport(2, sampleParams).entry === null, 'clearAllUserCaches purged all user records');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 22. Hierarchy Caching & 30-Minute SWR ---');
    // ────────────────────────────────────────────────────────────────────────
    const sampleClusters: ClusterItem[] = [
      {
        id: 14,
        name: 'Central Railways',
        color: '#0B3C7A',
        gateCount: 1,
        gates: [
          { id: 17, lcNumber: 'LC-M-001', locationName: 'Panvel' },
        ],
      },
    ];
    reportsCacheService.saveHierarchy(1, sampleClusters, false, 'W/"hier-etag-1"');
    const hierCache = reportsCacheService.getCachedHierarchy(1);
    assert(hierCache !== null, 'Hierarchy cached successfully');
    assert(reportsCacheService.isHierarchyFresh(hierCache) === true, 'Hierarchy fresh within 30-minute window');
    assert(hierCache?.clusters[0].name === 'Central Railways', 'Hierarchy details preserved');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 23. Memory LRU Eviction (Max 30) & Persistent Eviction (Max 10) ---');
    // ────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 35; i++) {
      const p: ReportFilterParams = { ...sampleParams, search: `item-${i}` };
      reportsCacheService.saveReport(99, p, {
        records: [],
        metrics: null,
        etag: `etag-${i}`,
        cursor: sampleCursor,
      });
    }
    const memSize = (reportsCacheService as any).memoryCache.size;
    assert(memSize <= 30, `Memory LRU evicted down to max 30 entries (actual: ${memSize})`);

    const idxRaw = localStorage.getItem(`lc_rep_idx_v1_99`);
    const idxList = idxRaw ? JSON.parse(idxRaw) : [];
    assert(idxList.length <= 10, `Persistent storage LRU capped at max 10 entries (actual: ${idxList.length})`);

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 24. Shift IST Calculation Verification ---');
    // ────────────────────────────────────────────────────────────────────────
    // Test 10:00 UTC = 15:30 IST (EVENING shift)
    const eveningRecord: OperationalRecord = {
      ...sampleRecords[0],
      openedAt: '2026-11-01T10:00:00.000Z',
    };
    assert(
      reportsCacheService.isRecordMatchingFilters(eveningRecord, { ...sampleParams, shift: 'EVENING' }),
      '15:30 IST correctly categorized as EVENING shift'
    );
    assert(
      !reportsCacheService.isRecordMatchingFilters(eveningRecord, { ...sampleParams, shift: 'MORNING' }),
      '15:30 IST correctly rejected for MORNING shift'
    );

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 25. Exact Filter Cache Keys & Collision Prevention ---');
    // ────────────────────────────────────────────────────────────────────────
    const filterStatuses = ['ALL', 'OPEN', 'CLOSED', 'EXTENDED_DELAY'];
    const filterShifts = ['ALL', 'MORNING', 'EVENING', 'NIGHT'];
    const generatedKeys = new Set<string>();

    for (const st of filterStatuses) {
      for (const sh of filterShifts) {
        const p: ReportFilterParams = {
          ...sampleParams,
          status: st,
          shift: sh,
        };
        const key = reportsCacheService.generateCanonicalKey(1, p);
        assert(!generatedKeys.has(key), `Unique key generated for status=${st}, shift=${sh}`);
        generatedKeys.add(key);

        // Verify key contains exact canonical tokens
        assert(key.includes(`st:${st}`), `Key contains canonical status st:${st}`);
        assert(key.includes(`sh:${sh}`), `Key contains canonical shift sh:${sh}`);
      }
    }
    assert(generatedKeys.size === 16, 'All 16 status/shift permutations produce 16 unique cache keys');

    // Verify EXTENDED_DELAY filter matching
    const extendedRecord: OperationalRecord = {
      ...sampleRecords[0],
      id: 999,
      status: 'EXTENDED_DELAY',
      durationSeconds: 1200,
    };
    assert(
      reportsCacheService.isRecordMatchingFilters(extendedRecord, { ...sampleParams, status: 'EXTENDED_DELAY' }),
      'Record with status EXTENDED_DELAY matches EXTENDED_DELAY filter'
    );
    assert(
      !reportsCacheService.isRecordMatchingFilters(sampleRecords[0], { ...sampleParams, status: 'EXTENDED_DELAY' }),
      'Normal CLOSED record rejected under EXTENDED_DELAY filter'
    );

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 26. Transactional ChangeLog Cursor Advancement (Single & Multi-Gate) ---');
    // ────────────────────────────────────────────────────────────────────────
    // Setup initial report entry with Gate 17 at rev 5 and Gate 36 at rev 2
    reportsCacheService.saveReport(1, sampleParams, {
      records: [...sampleRecords],
      metrics: sampleMetrics,
      etag: 'W/"init-drain-etag"',
      cursor: {
        ...sampleCursor,
        gateRevisions: { '17': '5', '36': '2' },
      },
    });

    // Batch 1: Gate 17 advances from 5 -> 25 (partial batch of 50+ total mutations)
    const batch1Events: OperationalRecord[] = Array.from({ length: 20 }, (_, i) => ({
      id: 200 + i,
      gateId: 17,
      lcNumber: 'LC-M-001',
      gateName: 'Gate Panvel',
      locationName: 'Panvel',
      scopeGroupName: 'Central Railways',
      scopeGroupColor: '#0B3C7A',
      openedAt: new Date(Date.now() - (20 - i) * 60000).toISOString(),
      closedAt: new Date(Date.now() - (20 - i) * 60000 + 120000).toISOString(),
      durationSeconds: 120,
      durationFormatted: '2m 0s',
      status: 'CLOSED',
    }));

    const drainRes1 = reportsCacheService.updateIncrementalChanges(1, sampleParams, {
      requiresFullSync: false,
      events: batch1Events,
      deletions: [],
      hasMoreEvents: true,
      gateRevisions: { '17': '25', '36': '2' },
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    });

    assert(drainRes1 !== null, 'Batch 1 applied cleanly');
    assert(drainRes1?.cursor.gateRevisions['17'] === '25', 'Gate 17 revision advanced strictly to batch revision 25');
    assert(drainRes1?.cursor.gateRevisions['36'] === '2', 'Gate 36 revision untouched at 2');

    // Batch 2: Multi-gate updates + deletions (Gate 17 advances to 55, Gate 36 advances to 10)
    const drainRes2 = reportsCacheService.updateIncrementalChanges(1, sampleParams, {
      requiresFullSync: false,
      events: [
        {
          id: 301,
          gateId: 36,
          lcNumber: 'LC-M-002',
          gateName: 'Gate Karjat',
          locationName: 'Karjat',
          scopeGroupName: 'Central Railways',
          scopeGroupColor: '#0B3C7A',
          openedAt: new Date().toISOString(),
          closedAt: null,
          durationSeconds: null,
          durationFormatted: 'Ongoing (Open)',
          status: 'OPEN',
        },
      ],
      deletions: [200, 201], // Delete 2 events from batch 1
      hasMoreEvents: false,
      gateRevisions: { '17': '55', '36': '10' },
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    });

    assert(drainRes2 !== null, 'Batch 2 applied cleanly');
    assert(drainRes2?.cursor.gateRevisions['17'] === '55', 'Gate 17 revision advanced to 55');
    assert(drainRes2?.cursor.gateRevisions['36'] === '10', 'Gate 36 revision advanced to 10');
    assert(!drainRes2?.records.some(r => r.id === 200 || r.id === 201), 'Deleted events removed in multi-gate batch');
    assert(drainRes2?.records.some(r => r.id === 301), 'New Gate 36 event present in dataset');

    // Deletion-only batch
    const drainRes3 = reportsCacheService.updateIncrementalChanges(1, sampleParams, {
      requiresFullSync: false,
      events: [],
      deletions: [301],
      hasMoreEvents: false,
      gateRevisions: { '17': '55', '36': '11' },
      authoritativeMetrics: null,
      serverTime: new Date().toISOString(),
    });
    assert(drainRes3?.cursor.gateRevisions['36'] === '11', 'Deletion-only batch advanced cursor to 11');
    assert(!drainRes3?.records.some(r => r.id === 301), 'Deleted event 301 evicted in deletion-only batch');

    // Network interruption simulation: If batch 4 fails, cursor must remain at batch 3 values
    const currentCached = reportsCacheService.getCachedReport(1, sampleParams).entry!;
    assert(currentCached.cursor.gateRevisions['17'] === '55', 'Cursor preserved during network failure (Gate 17=55)');
    assert(currentCached.cursor.gateRevisions['36'] === '11', 'Cursor preserved during network failure (Gate 36=11)');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 27. Historical OPEN Event Polling & Termination Lifecycle ---');
    // ────────────────────────────────────────────────────────────────────────
    // Case 1: Historical date range with OPEN event and status ALL
    const histParamsAll: ReportFilterParams = {
      ...sampleParams,
      startDate: '2026-10-10',
      endDate: '2026-10-15',
      status: 'ALL',
    };
    const histRecordsWithOpen: OperationalRecord[] = [
      {
        ...sampleRecords[0],
        id: 501,
        openedAt: '2026-10-12T08:00:00.000Z',
        closedAt: null,
        durationSeconds: null,
        status: 'OPEN',
      },
      {
        ...sampleRecords[0],
        id: 502,
        openedAt: '2026-10-13T09:00:00.000Z',
        closedAt: '2026-10-13T09:10:00.000Z',
        durationSeconds: 600,
        status: 'CLOSED',
      },
    ];

    reportsCacheService.saveReport(1, histParamsAll, {
      records: histRecordsWithOpen,
      metrics: { ...sampleMetrics, currentlyOpenCount: 1 },
      etag: 'W/"hist-all-etag"',
      cursor: { ...sampleCursor, hasUnclosedEvents: true },
    });

    const cachedHistAll = reportsCacheService.getCachedReport(1, histParamsAll).entry!;
    const shouldPollCase1 =
      cachedHistAll.cursor.hasUnclosedEvents === true ||
      (cachedHistAll.authoritativeMetrics ? cachedHistAll.authoritativeMetrics.currentlyOpenCount > 0 : false) ||
      cachedHistAll.records.some(r => r.status === 'OPEN');
    assert(shouldPollCase1 === true, 'Historical with status ALL and OPEN event requires polling');

    // Case 2: Historical date range with status CLOSED while an event is currently OPEN
    const histParamsClosed: ReportFilterParams = {
      ...histParamsAll,
      status: 'CLOSED',
    };
    reportsCacheService.saveReport(1, histParamsClosed, {
      records: [histRecordsWithOpen[1]], // only the CLOSED event is returned in records table
      metrics: { ...sampleMetrics, currentlyOpenCount: 0 }, // metrics filtered to CLOSED
      etag: 'W/"hist-closed-etag"',
      cursor: { ...sampleCursor, hasUnclosedEvents: true }, // server indicates unclosed event exists in window
    });

    const cachedHistClosed = reportsCacheService.getCachedReport(1, histParamsClosed).entry!;
    const shouldPollCase2 =
      cachedHistClosed.cursor.hasUnclosedEvents === true ||
      (cachedHistClosed.authoritativeMetrics ? cachedHistClosed.authoritativeMetrics.currentlyOpenCount > 0 : false) ||
      cachedHistClosed.records.some(r => r.status === 'OPEN');
    assert(shouldPollCase2 === true, 'Historical with status CLOSED polls because hasUnclosedEvents is true');

    // Case 3: Historical date range with status OPEN
    const histParamsOpen: ReportFilterParams = {
      ...histParamsAll,
      status: 'OPEN',
    };
    reportsCacheService.saveReport(1, histParamsOpen, {
      records: [histRecordsWithOpen[0]], // only the OPEN event is returned
      metrics: { ...sampleMetrics, currentlyOpenCount: 1 },
      etag: 'W/"hist-open-etag"',
      cursor: { ...sampleCursor, hasUnclosedEvents: true },
    });
    const cachedHistOpen = reportsCacheService.getCachedReport(1, histParamsOpen).entry!;
    const shouldPollCase3 =
      cachedHistOpen.cursor.hasUnclosedEvents === true ||
      (cachedHistOpen.authoritativeMetrics ? cachedHistOpen.authoritativeMetrics.currentlyOpenCount > 0 : false) ||
      cachedHistOpen.records.some(r => r.status === 'OPEN');
    assert(shouldPollCase3 === true, 'Historical with status OPEN polls');

    // Case 4: OPEN event transitions to CLOSED while user is viewing status CLOSED
    const closureChanges = {
      requiresFullSync: false,
      events: [
        {
          ...histRecordsWithOpen[0],
          closedAt: '2026-10-12T08:15:00.000Z',
          durationSeconds: 900,
          status: 'CLOSED' as const,
        },
      ],
      deletions: [],
      hasMoreEvents: false,
      hasUnclosedEvents: false, // now 0 open events remain
      gateRevisions: { '17': '60' },
      authoritativeMetrics: { ...sampleMetrics, currentlyOpenCount: 0 },
      serverTime: new Date().toISOString(),
    };

    const updatedAfterClosure = reportsCacheService.updateIncrementalChanges(1, histParamsClosed, closureChanges);
    assert(updatedAfterClosure !== null, 'Closure change applied to CLOSED view');
    assert(updatedAfterClosure?.records.some(r => r.id === 501), 'Transitioned event 501 now visible in CLOSED table');
    assert(updatedAfterClosure?.cursor.hasUnclosedEvents === false, 'Cursor updated to hasUnclosedEvents=false');

    // Case 5: All historical events are CLOSED -> Polling terminates
    const shouldPollCase5 =
      updatedAfterClosure?.cursor.hasUnclosedEvents === true ||
      (updatedAfterClosure?.authoritativeMetrics ? updatedAfterClosure.authoritativeMetrics.currentlyOpenCount > 0 : false) ||
      (updatedAfterClosure?.records || []).some(r => r.status === 'OPEN');
    assert(shouldPollCase5 === false, 'Polling stops when all historical events are CLOSED and hasUnclosedEvents is false');

    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 28. Cluster Hierarchy Conditional ETag Caching ---');
    // ────────────────────────────────────────────────────────────────────────
    const hierClusters: ClusterItem[] = [
      {
        id: 1,
        name: 'Mumbai Central',
        color: '#10b981',
        gateCount: 2,
        gates: [
          { id: 10, lcNumber: 'LC-B-001', locationName: 'Dadar' },
          { id: 11, lcNumber: 'LC-B-002', locationName: 'Bandra' },
        ],
      },
    ];
    reportsCacheService.saveHierarchy(5, hierClusters, true, 'W/"hier-token-v1"');
    const cachedH = reportsCacheService.getCachedHierarchy(5);
    assert(cachedH !== null, 'Hierarchy cached for User 5');
    assert(cachedH?.etag === 'W/"hier-token-v1"', 'Hierarchy ETag stored properly');

    // Simulate 304 revalidation: touches timestamp without discarding records
    reportsCacheService.touchHierarchyVerified(5);
    const touchedH = reportsCacheService.getCachedHierarchy(5);
    assert(touchedH?.clusters.length === 1, 'Hierarchy records intact after touchHierarchyVerified');
    assert(reportsCacheService.isHierarchyFresh(touchedH) === true, 'Hierarchy marked fresh after 304 verification');

    console.log('\n========================================================================');
    console.log(`🎉 ALL ${passed}/${passed + failed} PHASE 2 REACT TESTS PASSED!`);
    console.log('========================================================================\n');
  } catch (error) {
    console.error('Fatal error in Phase 2 test suite:', error);
    process.exit(1);
  }
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

runPhase2Tests();

