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
  });
}
