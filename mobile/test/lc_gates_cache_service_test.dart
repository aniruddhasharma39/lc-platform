import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:mobile/services/lc_gates_cache_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await LCGatesCacheService.instance.clearAllUserCaches();
  });

  group('LC Gates Intelligent Caching - Flutter Runtime Verification', () {
    const testUserId = 'test_user_42';
    const otherUserId = 'test_user_99';

    test('1. Memory + Disk Persistence: serialization and deserialization integrity', () async {
      final now = DateTime.now();
      final sampleGates = [
        {'id': 101, 'lcNumber': 'LC-01', 'name': 'Panvel West'},
        {'id': 102, 'lcNumber': 'LC-02', 'name': 'Diva Junction'},
      ];
      final sampleScopeGroups = [
        {'id': 1, 'name': 'Central Railway'},
      ];

      final cacheData = LCGatesCacheData(
        schemaVersion: 2,
        gates: sampleGates,
        scopeGroups: sampleScopeGroups,
        etag: 'W/"test-etag-123"',
        lastSyncedAt: now,
        gatesSyncedAt: now,
        scopeGroupsSyncedAt: now,
        hierarchySyncedAt: now,
      );

      final jsonMap = cacheData.toJson();
      final restored = LCGatesCacheData.fromJson(jsonMap);

      expect(restored.schemaVersion, equals(2));
      expect(restored.gates.length, equals(2));
      expect(restored.scopeGroups.length, equals(1));
      expect(restored.etag, equals('W/"test-etag-123"'));
      expect(restored.isFromCache, isTrue);
      expect(restored.isOutdated, isFalse);
    });

    test('2. TTL Evaluation: Fresh vs Expired metadata', () async {
      final cacheService = LCGatesCacheService.instance;

      // When no cache exists
      expect(cacheService.isGateMetadataFresh(testUserId), isFalse);
      expect(cacheService.isScopeGroupsFresh(testUserId), isFalse);

      // Save fresh cache
      final now = DateTime.now();
      final freshData = LCGatesCacheData(
        schemaVersion: 2,
        gates: [{'id': 1, 'lcNumber': 'LC-01'}],
        scopeGroups: [],
        etag: 'W/"etag-fresh"',
        lastSyncedAt: now,
        gatesSyncedAt: now,
        scopeGroupsSyncedAt: now,
      );

      // Force into memory cache
      await cacheService.hardClear(testUserId);
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('lc_gates_dir_v2_$testUserId', json.encode(freshData.toJson()));

      // Read from disk
      final loaded = await cacheService.getCachedDirectory(testUserId);
      expect(loaded, isNotNull);
      expect(cacheService.isGateMetadataFresh(testUserId), isTrue);
      expect(cacheService.isScopeGroupsFresh(testUserId), isTrue);

      // Simulate expired gate metadata (16 minutes ago, > 15m TTL)
      final expiredGateData = freshData.copyWith(
        gatesSyncedAt: now.subtract(const Duration(minutes: 16)),
      );
      await cacheService.hardClear(testUserId);
      await prefs.setString('lc_gates_dir_v2_$testUserId', json.encode(expiredGateData.toJson()));
      await cacheService.getCachedDirectory(testUserId);

      expect(cacheService.isGateMetadataFresh(testUserId), isFalse);
      // Scope groups still fresh (16 min < 30m TTL)
      expect(cacheService.isScopeGroupsFresh(testUserId), isTrue);
    });

    test('3. Cache Mutation Patching: patchGate updates gate in-memory & disk', () async {
      final cacheService = LCGatesCacheService.instance;
      final now = DateTime.now();

      final initialData = LCGatesCacheData(
        schemaVersion: 2,
        gates: [
          {'id': 10, 'lcNumber': 'LC-10', 'name': 'Old Name', 'masters': []},
        ],
        scopeGroups: [],
        etag: 'W/"etag-1"',
        lastSyncedAt: now,
      );

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('lc_gates_dir_v2_$testUserId', json.encode(initialData.toJson()));
      await cacheService.getCachedDirectory(testUserId);

      // Patch gate
      await cacheService.patchGate(testUserId, {
        'id': 10,
        'lcNumber': 'LC-10',
        'name': 'Updated Panvel Name',
        'masters': [{'id': 1, 'serialNumber': 'MST-001'}],
      });

      final memCached = cacheService.getMemoryCachedDirectory(testUserId);
      expect(memCached, isNotNull);
      final patchedGate = memCached!.gates.first as Map;
      expect(patchedGate['name'], equals('Updated Panvel Name'));
      expect((patchedGate['masters'] as List).length, equals(1));

      // Verify persisted to SharedPreferences
      final rawDisk = prefs.getString('lc_gates_dir_v2_$testUserId');
      expect(rawDisk, contains('Updated Panvel Name'));
    });

    test('4. Cache Mutation Removal: removeGate deletes gate from memory & disk', () async {
      final cacheService = LCGatesCacheService.instance;
      final now = DateTime.now();

      final initialData = LCGatesCacheData(
        schemaVersion: 2,
        gates: [
          {'id': 10, 'lcNumber': 'LC-10'},
          {'id': 20, 'lcNumber': 'LC-20'},
        ],
        scopeGroups: [],
        etag: 'W/"etag-2"',
        lastSyncedAt: now,
      );

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('lc_gates_dir_v2_$testUserId', json.encode(initialData.toJson()));
      await cacheService.getCachedDirectory(testUserId);

      // Remove gate 10
      await cacheService.removeGate(testUserId, 10);

      final memCached = cacheService.getMemoryCachedDirectory(testUserId);
      expect(memCached!.gates.length, equals(1));
      expect((memCached.gates.first as Map)['id'], equals(20));

      final rawDisk = prefs.getString('lc_gates_dir_v2_$testUserId');
      expect(rawDisk, isNot(contains('"id":10')));
      expect(rawDisk, contains('"id":20'));
    });

    test('5. Invalidation Mode 2: markStale resets ETag and forces revalidation', () async {
      final cacheService = LCGatesCacheService.instance;
      final now = DateTime.now();

      final initialData = LCGatesCacheData(
        schemaVersion: 2,
        gates: [{'id': 10, 'lcNumber': 'LC-10'}],
        scopeGroups: [],
        etag: 'W/"valid-etag"',
        lastSyncedAt: now,
        gatesSyncedAt: now,
        scopeGroupsSyncedAt: now,
      );

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('lc_gates_dir_v2_$testUserId', json.encode(initialData.toJson()));
      await cacheService.getCachedDirectory(testUserId);
      expect(cacheService.isGateMetadataFresh(testUserId), isTrue);

      // Mark stale on mutation
      await cacheService.markStale(testUserId);

      expect(cacheService.isGateMetadataFresh(testUserId), isFalse);
      final memCached = cacheService.getMemoryCachedDirectory(testUserId);
      expect(memCached?.etag, isNull);
    });

    test('6. User Cache Isolation: User A cache never leaks to User B', () async {
      final cacheService = LCGatesCacheService.instance;
      final now = DateTime.now();

      final dataA = LCGatesCacheData(
        schemaVersion: 2,
        gates: [{'id': 101, 'lcNumber': 'LC-USER-A'}],
        scopeGroups: [{'id': 1, 'name': 'Scope User A'}],
        etag: 'W/"etag-user-a"',
        lastSyncedAt: now,
      );
      final dataB = LCGatesCacheData(
        schemaVersion: 2,
        gates: [{'id': 202, 'lcNumber': 'LC-USER-B'}],
        scopeGroups: [{'id': 2, 'name': 'Scope User B'}],
        etag: 'W/"etag-user-b"',
        lastSyncedAt: now,
      );

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('lc_gates_dir_v2_$testUserId', json.encode(dataA.toJson()));
      await prefs.setString('lc_gates_dir_v2_$otherUserId', json.encode(dataB.toJson()));

      final cachedA = await cacheService.getCachedDirectory(testUserId);
      final cachedB = await cacheService.getCachedDirectory(otherUserId);

      expect((cachedA!.gates.first as Map)['lcNumber'], equals('LC-USER-A'));
      expect((cachedB!.gates.first as Map)['lcNumber'], equals('LC-USER-B'));
      expect(cachedA.etag, equals('W/"etag-user-a"'));
      expect(cachedB.etag, equals('W/"etag-user-b"'));

      // Clear User A only
      await cacheService.hardClear(testUserId);
      expect(cacheService.getMemoryCachedDirectory(testUserId), isNull);
      expect(cacheService.getMemoryCachedDirectory(otherUserId), isNotNull);
    });

    test('7. Device Status 45s TTL & Parsing Integrity', () async {
      final cacheService = LCGatesCacheService.instance;
      expect(cacheService.isDeviceStatusFresh(), isFalse);

      final statusJson = {
        'gateId': 101,
        'lcNumber': 'LC-01',
        'isOnline': true,
        'deviceStatus': 'ONLINE',
        'lastSeenAt': DateTime.now().toIso8601String(),
        'hasMaster': true,
        'mastersCount': 1,
      };

      final statusItem = GateStatusItem.fromJson(statusJson);
      expect(statusItem.gateId, equals(101));
      expect(statusItem.isOnline, isTrue);
      expect(statusItem.deviceStatus, equals('ONLINE'));
      expect(statusItem.hasMaster, isTrue);
      expect(statusItem.mastersCount, equals(1));
    });

    test('8. Cluster Scope-Isolated Caching: Scope A vs Scope B vs Default vs All', () async {
      final cacheService = LCGatesCacheService.instance;
      await cacheService.hardClear(testUserId);

      final gatesDefault = [{'id': 1, 'lcNumber': 'LC-DEFAULT'}];
      final gatesScope1 = [{'id': 2, 'lcNumber': 'LC-SCOPE-1'}];
      final gatesAll = [{'id': 1, 'lcNumber': 'LC-DEFAULT'}, {'id': 2, 'lcNumber': 'LC-SCOPE-1'}];

      await cacheService.saveGates(testUserId, gates: gatesDefault, etag: 'W/"etag-def"');
      await cacheService.saveGates(testUserId, gates: gatesScope1, etag: 'W/"etag-s1"', scopeGroupId: 'scope-1');
      await cacheService.saveGates(testUserId, gates: gatesAll, etag: 'W/"etag-all"', scopeGroupId: 'all');

      // Instant synchronous read verification
      final syncDef = cacheService.getCachedGatesSync(testUserId);
      final syncS1 = cacheService.getCachedGatesSync(testUserId, scopeGroupId: 'scope-1');
      final syncAll = cacheService.getCachedGatesSync(testUserId, scopeGroupId: 'all');

      expect(syncDef, isNotNull);
      expect(syncS1, isNotNull);
      expect(syncAll, isNotNull);

      expect((syncDef!.gates.first as Map)['lcNumber'], equals('LC-DEFAULT'));
      expect((syncS1!.gates.first as Map)['lcNumber'], equals('LC-SCOPE-1'));
      expect(syncAll!.gates.length, equals(2));
      expect(syncDef.etag, equals('W/"etag-def"'));
      expect(syncS1.etag, equals('W/"etag-s1"'));
      expect(syncAll.etag, equals('W/"etag-all"'));
    });

    test('9. HTTP 304 Touch Verification: touchVerified updates timestamp without modifying gates', () async {
      final cacheService = LCGatesCacheService.instance;
      await cacheService.hardClear(testUserId);

      final pastTime = DateTime.now().subtract(const Duration(minutes: 10));
      final initialData = LCGatesCacheData(
        schemaVersion: 2,
        gates: [{'id': 42, 'lcNumber': 'LC-42'}],
        scopeGroups: [],
        etag: 'W/"etag-304"',
        lastSyncedAt: pastTime,
        gatesSyncedAt: pastTime,
      );

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('lc_cluster_v2_u${testUserId}_sdefault_d0', json.encode(initialData.toJson()));

      // Load into memory
      final loaded = await cacheService.getCachedGates(testUserId);
      expect(loaded, isNotNull);
      expect(loaded!.lastSyncedAt.isBefore(DateTime.now().subtract(const Duration(minutes: 9))), isTrue);

      // Touch verified on 304
      await cacheService.touchVerified(testUserId);

      final touched = cacheService.getCachedGatesSync(testUserId);
      expect(touched, isNotNull);
      expect(touched!.lastSyncedAt.difference(DateTime.now()).inSeconds.abs() < 2, isTrue);
      expect((touched.gates.first as Map)['id'], equals(42));
      expect(touched.etag, equals('W/"etag-304"'));
    });

    test('10. Cross-Scope Gate Mutation Removal: deletes gate from all active cached scopes', () async {
      final cacheService = LCGatesCacheService.instance;
      await cacheService.hardClear(testUserId);

      final gateA = {'id': 100, 'lcNumber': 'LC-SHARED-100'};
      final gateB = {'id': 200, 'lcNumber': 'LC-OTHER-200'};

      await cacheService.saveGates(testUserId, gates: [gateA, gateB]);
      await cacheService.saveGates(testUserId, gates: [gateA], scopeGroupId: 'scope-special');

      // Remove gate 100 across all scopes
      await cacheService.removeGateAcrossAllScopes(testUserId, 100);

      final defUpdated = cacheService.getCachedGatesSync(testUserId);
      final specialUpdated = cacheService.getCachedGatesSync(testUserId, scopeGroupId: 'scope-special');

      expect(defUpdated!.gates.length, equals(1));
      expect((defUpdated.gates.first as Map)['id'], equals(200));
      expect(specialUpdated!.gates, isEmpty);
    });

    test('11. Reference Data Caching: railway zones & divisions with versioned ETag', () async {
      final cacheService = LCGatesCacheService.instance;

      final zones = ['CENTRAL RAILWAY', 'WESTERN RAILWAY'];
      final divisions = {
        'CENTRAL RAILWAY': ['MUMBAI CST', 'BHUSAWAL'],
        'WESTERN RAILWAY': ['MUMBAI CENTRAL', 'VADODARA'],
      };

      await cacheService.saveReferenceData(
        zones: zones,
        divisionsByZone: divisions,
        etag: 'W/"railway-ref-v1"',
      );

      final cached = await cacheService.getCachedReferenceData();
      expect(cached, isNotNull);
      expect(cached!.zones.length, equals(2));
      expect(cached.divisionsByZone['CENTRAL RAILWAY']!.contains('MUMBAI CST'), isTrue);
      expect(cached.etag, equals('W/"railway-ref-v1"'));
    });

    test('12. Corrupted Disk JSON Resilience: safely falls back to null without crashing', () async {
      final cacheService = LCGatesCacheService.instance;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('lc_cluster_v2_u${testUserId}_scorrupted_d0', '{"corrupted: true, invalid json');

      final result = await cacheService.getCachedGates(testUserId, scopeGroupId: 'corrupted');
      expect(result, isNull);
    });
  });
}
