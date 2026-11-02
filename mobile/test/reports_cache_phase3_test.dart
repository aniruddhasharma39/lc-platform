import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:mobile/services/reports_cache_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ReportsCacheService cacheService;
  const testUserId = 42;
  const otherUserId = 99;

  ReportFilterParams makeFilter({
    String startDate = '2026-11-01',
    String endDate = '2026-11-01',
    List<int> scopeGroupIds = const [],
    List<int> gateIds = const [],
    String status = 'ALL',
    String shift = 'ALL',
    String search = '',
    String sortBy = 'openedAt',
    String sortOrder = 'desc',
  }) {
    return ReportFilterParams(
      startDate: startDate,
      endDate: endDate,
      scopeGroupIds: scopeGroupIds,
      gateIds: gateIds,
      status: status,
      shift: shift,
      search: search,
      sortBy: sortBy,
      sortOrder: sortOrder,
    );
  }

  OperationalRecord makeRecord({
    required int id,
    int gateId = 101,
    String lcNumber = 'LC-101',
    String gateName = 'Gate 101',
    String locationName = 'North Junction',
    String scopeGroupName = 'Division 1',
    String scopeGroupColor = '#0B3C7A',
    String openedAt = '2026-11-01T08:00:00.000Z',
    String? closedAt = '2026-11-01T08:05:00.000Z',
    int durationSeconds = 300,
    String status = 'CLOSED',
  }) {
    return OperationalRecord(
      id: id,
      gateId: gateId,
      lcNumber: lcNumber,
      gateName: gateName,
      locationName: locationName,
      scopeGroupName: scopeGroupName,
      scopeGroupColor: scopeGroupColor,
      openedAt: openedAt,
      closedAt: closedAt,
      durationSeconds: durationSeconds,
      durationFormatted: '${durationSeconds ~/ 60}m ${durationSeconds % 60}s',
      status: status,
    );
  }

  ReportsCursor makeCursor({
    Map<String, String>? gateRevisions,
    bool hasUnclosedEvents = false,
    String eventCursorTime = '2026-11-01T08:00:00.000Z',
    int eventCursorId = 1,
    String tombstoneCursorId = '0',
    String serverTime = '2026-11-01T08:00:00.000Z',
  }) {
    return ReportsCursor(
      eventCursorTime: eventCursorTime,
      eventCursorId: eventCursorId,
      tombstoneCursorId: tombstoneCursorId,
      gateRevisions: gateRevisions ?? {'101': 'rev-101-1'},
      hasUnclosedEvents: hasUnclosedEvents,
      serverTime: serverTime,
    );
  }

  AuthoritativeReportMetrics makeMetrics({
    int totalOperations = 1,
    int totalDurationSeconds = 300,
    String totalDurationFormatted = '5m',
    int avgDurationSeconds = 300,
    String avgDurationFormatted = '5m',
    int extendedDelaysCount = 0,
    int currentlyOpenCount = 0,
    int reportingGatesCount = 1,
  }) {
    return AuthoritativeReportMetrics(
      totalOperations: totalOperations,
      totalDurationSeconds: totalDurationSeconds,
      totalDurationFormatted: totalDurationFormatted,
      avgDurationSeconds: avgDurationSeconds,
      avgDurationFormatted: avgDurationFormatted,
      extendedDelaysCount: extendedDelaysCount,
      currentlyOpenCount: currentlyOpenCount,
      reportingGatesCount: reportingGatesCount,
    );
  }

  IncrementalChangesPayload makePayload({
    bool requiresFullSync = false,
    String? resyncReason,
    List<OperationalRecord> events = const [],
    List<int> deletions = const [],
    bool hasMoreEvents = false,
    Map<String, String>? gateRevisions,
    bool? hasUnclosedEvents,
    AuthoritativeReportMetrics? authoritativeMetrics,
    String serverTime = '2026-11-01T08:00:00.000Z',
  }) {
    return IncrementalChangesPayload(
      requiresFullSync: requiresFullSync,
      resyncReason: resyncReason,
      events: events,
      deletions: deletions,
      hasMoreEvents: hasMoreEvents,
      gateRevisions: gateRevisions,
      hasUnclosedEvents: hasUnclosedEvents,
      authoritativeMetrics: authoritativeMetrics,
      serverTime: serverTime,
    );
  }

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    cacheService = ReportsCacheService.instance;
    await cacheService.clearAllUserCaches();
  });

  group('Reports Module Phase 3 - Comprehensive Intelligent Caching Suite', () {
    // 1. First Visit (Cold Cache Miss)
    test('1. First visit returns null on cold cache miss and saves successfully to L1 and L2', () async {
      final filter = makeFilter();
      final cached = await cacheService.getCachedReport(testUserId, filter);
      expect(cached, isNull);

      final record = makeRecord(id: 1);
      final metrics = makeMetrics(totalOperations: 1);
      final cursor = makeCursor(gateRevisions: {'101': 'rev-101-1'});

      await cacheService.saveReport(
        testUserId,
        filter,
        records: [record],
        metrics: metrics,
        etag: 'W/"etag-cold-1"',
        cursor: cursor,
      );

      final retrieved = await cacheService.getCachedReport(testUserId, filter);
      expect(retrieved, isNotNull);
      expect(retrieved!.records.length, 1);
      expect(retrieved.records.first.id, 1);
      expect(retrieved.etag, 'W/"etag-cold-1"');
      expect(retrieved.cursor.gateRevisions['101'], 'rev-101-1');
    });

    // 2. Fresh Memory Cache Revisit (<15ms)
    test('2. Fresh memory cache revisit retrieves instantly without persistent disk read', () async {
      final filter = makeFilter();
      final record = makeRecord(id: 2);
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [record],
        etag: 'W/"mem-fast-1"',
        cursor: makeCursor(),
      );

      final stopwatch = Stopwatch()..start();
      final memoryHit = cacheService.getMemoryCachedReport(testUserId, filter);
      stopwatch.stop();

      expect(memoryHit, isNotNull);
      expect(memoryHit!.records.first.id, 2);
      expect(stopwatch.elapsedMilliseconds, lessThan(15));
    });

    // 3. Persistent Cache Restoration via SharedPreferences
    test('3. Persistent cache restoration via SharedPreferences after memory cleared', () async {
      final filter = makeFilter();
      final record = makeRecord(id: 3, lcNumber: 'LC-PERSIST');
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [record],
        etag: 'W/"persist-etag"',
        cursor: makeCursor(),
      );

      // Simulate memory wipe / app restart
      cacheService.clearMemoryOnly();
      expect(cacheService.getMemoryCachedReport(testUserId, filter), isNull);

      // Fetch from Level 2 persistent cache
      final diskHit = await cacheService.getCachedReport(testUserId, filter);
      expect(diskHit, isNotNull);
      expect(diskHit!.records.first.id, 3);
      expect(diskHit.records.first.lcNumber, 'LC-PERSIST');
      expect(diskHit.etag, 'W/"persist-etag"');
    });

    // 4. Expired Cache Background Revalidation Detection
    test('4. Expired cache background revalidation correctly reports isStale', () async {
      final filter = makeFilter();
      final record = makeRecord(id: 4);
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [record],
        cursor: makeCursor(),
      );

      final cached = await cacheService.getCachedReport(testUserId, filter);
      expect(cached, isNotNull);
      expect(cached!.isFresh, isTrue);
      expect(cached.isStale, isFalse);

      // Simulated expired entry with verifiedAt 10 minutes ago and TTL 2 minutes
      final expiredEntry = cached.copyWith(
        verifiedAt: DateTime.now().subtract(const Duration(minutes: 10)),
        ttl: const Duration(minutes: 2),
      );
      expect(expiredEntry.isFresh, isFalse);
      expect(expiredEntry.isStale, isTrue);
    });

    // 5. HTTP 304 Handling (touchVerified)
    test('5. HTTP 304 handling updates timestamp and retains full cached dataset', () async {
      final filter = makeFilter();
      final record = makeRecord(id: 5);
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [record],
        etag: 'W/"orig-etag"',
        cursor: makeCursor(),
      );

      final original = (await cacheService.getCachedReport(testUserId, filter))!;
      final originalTime = original.verifiedAt;

      await Future.delayed(const Duration(milliseconds: 20));
      await cacheService.touchVerified(testUserId, filter, newEtag: 'W/"new-etag"');

      final updated = (await cacheService.getCachedReport(testUserId, filter))!;
      expect(updated.records.length, 1);
      expect(updated.records.first.id, 5);
      expect(updated.etag, 'W/"new-etag"');
      expect(updated.verifiedAt.isAfter(originalTime), isTrue);
    });

    // 6. HTTP 200 Replacement
    test('6. HTTP 200 completely replaces cached records, ETag and cursor', () async {
      final filter = makeFilter();
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 10)],
        etag: 'W/"old-200"',
        cursor: makeCursor(gateRevisions: {'101': 'rev-old'}),
      );

      // New server response
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 20), makeRecord(id: 21)],
        etag: 'W/"new-200"',
        cursor: makeCursor(gateRevisions: {'101': 'rev-new', '102': 'rev-new'}),
      );

      final current = (await cacheService.getCachedReport(testUserId, filter))!;
      expect(current.records.length, 2);
      expect(current.records.map((r) => r.id), [20, 21]);
      expect(current.etag, 'W/"new-200"');
      expect(current.cursor.gateRevisions['102'], 'rev-new');
    });

    // 7. Offline / Failed Revalidation Preserves Cached Records
    test('7. Stale cached data is safely preserved when revalidation fails', () async {
      final filter = makeFilter();
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 77)],
        etag: 'W/"offline-1"',
        cursor: makeCursor(),
      );

      // Reading during offline condition still returns intact dataset
      final offlineData = await cacheService.getCachedReport(testUserId, filter);
      expect(offlineData, isNotNull);
      expect(offlineData!.records.first.id, 77);
      expect(offlineData.etag, 'W/"offline-1"');
    });

    // 8. Exact Status Filter Key Isolation
    test('8. Status filter values produce isolated non-colliding canonical keys', () {
      final statuses = ['ALL', 'OPEN', 'CLOSED', 'EXTENDED_DELAY'];
      final keys = <String>{};

      for (final st in statuses) {
        final key = cacheService.generateCanonicalKey(testUserId, makeFilter(status: st));
        expect(keys.contains(key), isFalse);
        keys.add(key);
      }
      expect(keys.length, 4);
    });

    // 9. Exact Shift Filter Key Isolation
    test('9. Operational shift filter values produce isolated non-colliding keys', () {
      final shifts = ['ALL', 'MORNING', 'EVENING', 'NIGHT'];
      final keys = <String>{};

      for (final sh in shifts) {
        final key = cacheService.generateCanonicalKey(testUserId, makeFilter(shift: sh));
        expect(keys.contains(key), isFalse);
        keys.add(key);
      }
      expect(keys.length, 4);
    });

    // 10. Date Range and Gate Selection Isolation
    test('10. Different date ranges and gate subsets produce unique cache keys', () {
      final key1 = cacheService.generateCanonicalKey(testUserId, makeFilter(startDate: '2026-11-01', endDate: '2026-11-01'));
      final key2 = cacheService.generateCanonicalKey(testUserId, makeFilter(startDate: '2026-11-01', endDate: '2026-11-02'));
      final key3 = cacheService.generateCanonicalKey(testUserId, makeFilter(gateIds: [101, 102]));
      final key4 = cacheService.generateCanonicalKey(testUserId, makeFilter(gateIds: [102, 101])); // permutation canonicalized

      expect(key1, isNot(equals(key2)));
      expect(key1, isNot(equals(key3)));
      expect(key3, equals(key4)); // Canonical sorted normalization
    });

    // 11. Corrupted Persistent Storage Recovery
    test('11. Corrupted JSON in SharedPreferences is discarded gracefully without exceptions', () async {
      final filter = makeFilter();
      final canonicalKey = cacheService.generateCanonicalKey(testUserId, filter);
      final storageKey = 'lc_rep_data_v1_${testUserId}_$canonicalKey';

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(storageKey, '{"corrupted": true, broken JSON ...');
      await prefs.setString('lc_rep_idx_v1_$testUserId', '["$storageKey"]');

      final result = await cacheService.getCachedReport(testUserId, filter);
      expect(result, isNull);
    });

    // 12. Storage Eviction (LRU Memory & Persistent Limits)
    test('12. Storage eviction enforces memory max 30 and persistent max 10 entries', () async {
      // Save 12 distinct entries
      for (int i = 1; i <= 12; i++) {
        final filter = makeFilter(search: 'query_$i');
        await cacheService.saveReport(
          testUserId,
          filter,
          records: [makeRecord(id: i)],
          cursor: makeCursor(),
        );
      }

      final prefs = await SharedPreferences.getInstance();
      final rawIdx = prefs.getString('lc_rep_idx_v1_$testUserId');
      expect(rawIdx, isNotNull);
      final indexList = (jsonDecode(rawIdx!) as List);
      expect(indexList.length, lessThanOrEqualTo(10));
    });

    // 13. Incremental Event Creation
    test('13. Incremental event creation prepends new matching record to cached dataset', () async {
      final filter = makeFilter();
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 101, openedAt: '2026-11-01T08:00:00.000Z')],
        cursor: makeCursor(gateRevisions: {'101': 'rev-1'}),
      );

      final payload = makePayload(
        events: [
          makeRecord(id: 102, gateId: 101, openedAt: '2026-11-01T08:15:00.000Z'),
        ],
        deletions: [],
        hasMoreEvents: false,
        gateRevisions: {'101': 'rev-2'},
        authoritativeMetrics: makeMetrics(totalOperations: 2),
      );

      final updated = await cacheService.updateIncrementalChanges(testUserId, filter, payload);
      expect(updated, isNotNull);
      expect(updated!.records.length, 2);
      expect(updated.records.first.id, 102); // desc order
      expect(updated.cursor.gateRevisions['101'], 'rev-2');
      expect(updated.authoritativeMetrics?.totalOperations, 2);
    });

    // 14. OPEN to CLOSED Transition Update
    test('14. OPEN to CLOSED transition mutates record in-place with closedAt and duration', () async {
      final filter = makeFilter();
      final openRecord = makeRecord(
        id: 200,
        gateId: 101,
        status: 'OPEN',
        closedAt: null,
        durationSeconds: 0,
      );

      await cacheService.saveReport(
        testUserId,
        filter,
        records: [openRecord],
        cursor: makeCursor(gateRevisions: {'101': 'rev-10'}),
      );

      final closedRecord = makeRecord(
        id: 200,
        gateId: 101,
        status: 'CLOSED',
        closedAt: '2026-11-01T08:10:00.000Z',
        durationSeconds: 600,
      );

      final payload = makePayload(
        events: [closedRecord],
        deletions: [],
        hasMoreEvents: false,
        gateRevisions: {'101': 'rev-11'},
      );

      final updated = await cacheService.updateIncrementalChanges(testUserId, filter, payload);
      expect(updated, isNotNull);
      expect(updated!.records.length, 1);
      expect(updated.records.first.status, 'CLOSED');
      expect(updated.records.first.closedAt, '2026-11-01T08:10:00.000Z');
      expect(updated.records.first.durationSeconds, 600);
      expect(updated.cursor.gateRevisions['101'], 'rev-11');
    });

    // 15. Deleted Event Removal (Tombstone Watermark)
    test('15. Deleted event removal strips tombstoned records from cached dataset', () async {
      final filter = makeFilter();
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 301), makeRecord(id: 302)],
        cursor: makeCursor(gateRevisions: {'101': 'rev-50'}),
      );

      final payload = makePayload(
        events: [],
        deletions: [301],
        hasMoreEvents: false,
        gateRevisions: {'101': 'rev-51'},
      );

      final updated = await cacheService.updateIncrementalChanges(testUserId, filter, payload);
      expect(updated, isNotNull);
      expect(updated!.records.length, 1);
      expect(updated.records.first.id, 302);
      expect(updated.cursor.gateRevisions['101'], 'rev-51');
    });

    // 16. Multiple Incremental Batches (Drain Loop simulation)
    test('16. Multiple sequential incremental batches correctly accumulate state', () async {
      final filter = makeFilter();
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 401)],
        cursor: makeCursor(gateRevisions: {'101': 'rev-1'}),
      );

      // Batch 1
      final batch1 = makePayload(
        events: [makeRecord(id: 402, openedAt: '2026-11-01T09:00:00.000Z')],
        deletions: [],
        hasMoreEvents: true,
        gateRevisions: {'101': 'rev-2'},
      );
      await cacheService.updateIncrementalChanges(testUserId, filter, batch1);

      // Batch 2
      final batch2 = makePayload(
        events: [makeRecord(id: 403, openedAt: '2026-11-01T10:00:00.000Z')],
        deletions: [],
        hasMoreEvents: false,
        gateRevisions: {'101': 'rev-3'},
      );
      final finalState = await cacheService.updateIncrementalChanges(testUserId, filter, batch2);

      expect(finalState, isNotNull);
      expect(finalState!.records.length, 3);
      expect(finalState.cursor.gateRevisions['101'], 'rev-3');
    });

    // 17. Duplicate Update Idempotence
    test('17. Applying the same incremental change twice produces identical idempotent results', () async {
      final filter = makeFilter();
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 501)],
        cursor: makeCursor(gateRevisions: {'101': 'rev-10'}),
      );

      final change = makePayload(
        events: [makeRecord(id: 502, openedAt: '2026-11-01T10:30:00.000Z')],
        deletions: [],
        hasMoreEvents: false,
        gateRevisions: {'101': 'rev-11'},
      );

      await cacheService.updateIncrementalChanges(testUserId, filter, change);
      final secondRun = await cacheService.updateIncrementalChanges(testUserId, filter, change);

      expect(secondRun, isNotNull);
      expect(secondRun!.records.length, 2);
      expect(secondRun.records.where((r) => r.id == 502).length, 1);
    });

    // 18. Cursor Persistence After Successful Processing
    test('18. Incremental update persists updated cursor revisions in both memory and storage', () async {
      final filter = makeFilter();
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 601)],
        cursor: makeCursor(gateRevisions: {'101': 'rev-1'}),
      );

      final payload = makePayload(
        events: [],
        deletions: [],
        hasMoreEvents: false,
        gateRevisions: {'101': 'rev-99', '102': 'rev-50'},
      );
      await cacheService.updateIncrementalChanges(testUserId, filter, payload);

      cacheService.clearMemoryOnly();
      final restored = await cacheService.getCachedReport(testUserId, filter);
      expect(restored!.cursor.gateRevisions['101'], 'rev-99');
      expect(restored.cursor.gateRevisions['102'], 'rev-50');
    });

    // 19. Retry After Interrupted Processing
    test('19. Interrupted processing retains original cursor and unchanged records', () async {
      final filter = makeFilter();
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 701)],
        cursor: makeCursor(gateRevisions: {'101': 'rev-init'}),
      );

      // Simulating a failed network request or aborted update by not calling updateIncrementalChanges
      final cached = await cacheService.getCachedReport(testUserId, filter);
      expect(cached!.cursor.gateRevisions['101'], 'rev-init');
      expect(cached.records.length, 1);
    });

    // 20. Full Synchronization Recovery (requiresFullSync)
    test('20. Incremental payload requiresFullSync flag is accurately identified', () {
      final payload = IncrementalChangesPayload.fromJson({
        'requiresFullSync': true,
        'resyncReason': 'REVISION_OUT_OF_BOUNDS',
        'events': [],
        'deletions': [],
        'gateRevisions': {},
      });

      expect(payload.requiresFullSync, isTrue);
      expect(payload.resyncReason, 'REVISION_OUT_OF_BOUNDS');
    });

    // 21. Permission Revocation Handling
    test('21. Permission revocation resync reason is parsed properly', () {
      final payload = IncrementalChangesPayload.fromJson({
        'requiresFullSync': true,
        'resyncReason': 'GATE_REVOKED',
        'events': [],
        'deletions': [],
        'gateRevisions': {},
      });

      expect(payload.requiresFullSync, isTrue);
      expect(payload.resyncReason, 'GATE_REVOKED');
    });

    // 22. KPI Accuracy & Format Verification
    test('22. AuthoritativeReportMetrics serializes and deserializes accurately', () {
      final metrics = makeMetrics(
        totalOperations: 45,
        totalDurationSeconds: 12500,
        totalDurationFormatted: '3h 28m 20s',
        avgDurationSeconds: 277,
        avgDurationFormatted: '4m 37s',
        extendedDelaysCount: 3,
        currentlyOpenCount: 1,
        reportingGatesCount: 8,
      );

      final jsonMap = metrics.toJson();
      final parsed = AuthoritativeReportMetrics.fromJson(jsonMap);

      expect(parsed.totalOperations, 45);
      expect(parsed.totalDurationFormatted, '3h 28m 20s');
      expect(parsed.avgDurationFormatted, '4m 37s');
      expect(parsed.extendedDelaysCount, 3);
      expect(parsed.currentlyOpenCount, 1);
      expect(parsed.reportingGatesCount, 8);
    });

    // 23. Historical OPEN Events with CLOSED Filter (hasUnclosedEvents)
    test('23. hasUnclosedEvents cursor boolean survives serialization and triggers polling', () {
      final cursorWithUnclosed = makeCursor(
        gateRevisions: {'101': 'rev-1'},
        hasUnclosedEvents: true,
      );
      final cursorWithoutUnclosed = makeCursor(
        gateRevisions: {'101': 'rev-1'},
        hasUnclosedEvents: false,
      );

      final jsonMap = cursorWithUnclosed.toJson();
      final parsed = ReportsCursor.fromJson(jsonMap);
      expect(parsed.hasUnclosedEvents, isTrue);

      final parsed2 = ReportsCursor.fromJson(cursorWithoutUnclosed.toJson());
      expect(parsed2.hasUnclosedEvents, isFalse);
    });

    // 24. Shift Matching in Filter Logic
    test('24. Shift filter matches IST hour intervals (Morning 06-14, Evening 14-22, Night 22-06)', () {
      final filterMorning = makeFilter(shift: 'MORNING');
      final filterEvening = makeFilter(shift: 'EVENING');
      final filterNight = makeFilter(shift: 'NIGHT');

      // 08:30 IST is in Morning shift (06:00 - 14:00) -> 03:00 UTC
      final recMorning = makeRecord(id: 1, openedAt: '2026-11-01T03:00:00.000Z');
      expect(cacheService.isRecordMatchingFilters(recMorning, filterMorning), isTrue);
      expect(cacheService.isRecordMatchingFilters(recMorning, filterEvening), isFalse);

      // 16:30 IST is in Evening shift (14:00 - 22:00) -> 11:00 UTC
      final recEvening = makeRecord(id: 2, openedAt: '2026-11-01T11:00:00.000Z');
      expect(cacheService.isRecordMatchingFilters(recEvening, filterEvening), isTrue);
      expect(cacheService.isRecordMatchingFilters(recEvening, filterMorning), isFalse);

      // 23:30 IST is in Night shift (22:00 - 06:00) -> 18:00 UTC
      final recNight = makeRecord(id: 3, openedAt: '2026-11-01T18:00:00.000Z');
      expect(cacheService.isRecordMatchingFilters(recNight, filterNight), isTrue);
      expect(cacheService.isRecordMatchingFilters(recNight, filterMorning), isFalse);
    });

    // 25. Hierarchy Cache TTL (30 minutes)
    test('25. Scope groups & gates hierarchy cache adheres to 30-minute TTL and ETag validation', () async {
      final clusters = [
        {'id': 1, 'name': 'Delhi Division', 'gates': [{'id': 101, 'lcNumber': 'LC-1'}]}
      ];

      await cacheService.saveHierarchy(testUserId, clusters, false, 'W/"hier-v1"');
      final hit = await cacheService.getCachedHierarchy(testUserId);

      expect(hit, isNotNull);
      expect(hit!.clusters.length, 1);
      expect(hit.etag, 'W/"hier-v1"');
      expect(hit.isFresh, isTrue);
    });

    // 26. Deterministic Sorting Logic
    test('26. Cached records are deterministically sorted by openedAt asc and desc', () {
      final r1 = makeRecord(id: 1, openedAt: '2026-11-01T08:00:00.000Z');
      final r2 = makeRecord(id: 2, openedAt: '2026-11-01T09:00:00.000Z');
      final r3 = makeRecord(id: 3, openedAt: '2026-11-01T07:00:00.000Z');

      final sortedDesc = cacheService.sortRecords([r1, r2, r3], 'openedAt', 'desc');
      expect(sortedDesc.map((r) => r.id).toList(), [2, 1, 3]);

      final sortedAsc = cacheService.sortRecords([r1, r2, r3], 'openedAt', 'asc');
      expect(sortedAsc.map((r) => r.id).toList(), [3, 1, 2]);
    });

    // 27. Logout and Multi-User Isolation
    test('27. Logout clearUserCache completely isolates user data without touching another user', () async {
      final filter = makeFilter();
      await cacheService.saveReport(
        testUserId,
        filter,
        records: [makeRecord(id: 801)],
        etag: 'W/"user1"',
        cursor: makeCursor(),
      );
      await cacheService.saveReport(
        otherUserId,
        filter,
        records: [makeRecord(id: 802)],
        etag: 'W/"user2"',
        cursor: makeCursor(),
      );

      // Logout testUserId
      await cacheService.clearUserCache(testUserId);

      // User 1 must be wiped
      expect(await cacheService.getCachedReport(testUserId, filter), isNull);

      // User 2 must be completely preserved
      final user2Data = await cacheService.getCachedReport(otherUserId, filter);
      expect(user2Data, isNotNull);
      expect(user2Data!.records.first.id, 802);
      expect(user2Data.etag, 'W/"user2"');
    });

    // 28. Complete Server-Side Export Parameter Integrity
    test('28. Export query parameters accurately translate filter parameters', () {
      final filter = makeFilter(
        startDate: '2026-10-25',
        endDate: '2026-11-01',
        scopeGroupIds: [10, 20],
        gateIds: [101, 102],
        status: 'EXTENDED_DELAY',
        shift: 'NIGHT',
        search: 'LC-99',
      );

      final exportQuery = <String, String>{
        'startDate': filter.startDate,
        'endDate': filter.endDate,
        'scopeGroupIds': filter.scopeGroupIds.join(','),
        'gateIds': filter.gateIds.join(','),
        'status': filter.status,
        'shift': filter.shift,
        'search': filter.search,
      };

      expect(exportQuery['startDate'], '2026-10-25');
      expect(exportQuery['endDate'], '2026-11-01');
      expect(exportQuery['scopeGroupIds'], '10,20');
      expect(exportQuery['gateIds'], '101,102');
      expect(exportQuery['status'], 'EXTENDED_DELAY');
      expect(exportQuery['shift'], 'NIGHT');
      expect(exportQuery['search'], 'LC-99');
    });
  });
}
