import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';

class GateStatusItem {
  final int gateId;
  final String lcNumber;
  final bool isOnline;
  final String deviceStatus; // ONLINE, OFFLINE
  final String? lastSeenAt;
  final bool hasMaster;
  final int mastersCount;

  GateStatusItem({
    required this.gateId,
    required this.lcNumber,
    required this.isOnline,
    required this.deviceStatus,
    this.lastSeenAt,
    this.hasMaster = false,
    this.mastersCount = 0,
  });

  factory GateStatusItem.fromJson(Map<String, dynamic> json) {
    return GateStatusItem(
      gateId: json['gateId'] is int
          ? json['gateId']
          : int.tryParse(json['gateId']?.toString() ?? '0') ?? 0,
      lcNumber: json['lcNumber']?.toString() ?? '',
      isOnline: json['isOnline'] == true,
      deviceStatus: json['deviceStatus']?.toString() ?? 'OFFLINE',
      lastSeenAt: json['lastSeenAt']?.toString(),
      hasMaster: json['hasMaster'] == true,
      mastersCount: json['mastersCount'] is int
          ? json['mastersCount']
          : int.tryParse(json['mastersCount']?.toString() ?? '0') ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
    'gateId': gateId,
    'lcNumber': lcNumber,
    'isOnline': isOnline,
    'deviceStatus': deviceStatus,
    'lastSeenAt': lastSeenAt,
    'hasMaster': hasMaster,
    'mastersCount': mastersCount,
  };
}

class LCGatesCacheData {
  static const int currentSchemaVersion = 2;
  final int schemaVersion;
  final List<dynamic> gates;
  final List<dynamic> scopeGroups;
  final String? etag;
  final DateTime lastSyncedAt;
  final DateTime? gatesSyncedAt;
  final DateTime? scopeGroupsSyncedAt;
  final DateTime? hierarchySyncedAt;
  final bool isFromCache;
  final bool isOutdated;

  LCGatesCacheData({
    this.schemaVersion = currentSchemaVersion,
    required this.gates,
    required this.scopeGroups,
    this.etag,
    required this.lastSyncedAt,
    this.gatesSyncedAt,
    this.scopeGroupsSyncedAt,
    this.hierarchySyncedAt,
    this.isFromCache = false,
    this.isOutdated = false,
  });

  Map<String, dynamic> toJson() => {
    'schemaVersion': schemaVersion,
    'gates': gates,
    'scopeGroups': scopeGroups,
    'etag': etag,
    'lastSyncedAt': lastSyncedAt.toIso8601String(),
    'gatesSyncedAt': (gatesSyncedAt ?? lastSyncedAt).toIso8601String(),
    'scopeGroupsSyncedAt': (scopeGroupsSyncedAt ?? lastSyncedAt).toIso8601String(),
    'hierarchySyncedAt': (hierarchySyncedAt ?? lastSyncedAt).toIso8601String(),
  };

  factory LCGatesCacheData.fromJson(Map<String, dynamic> json) {
    final lastSynced = json['lastSyncedAt'] != null
        ? DateTime.tryParse(json['lastSyncedAt'].toString()) ?? DateTime.now()
        : DateTime.now();
    return LCGatesCacheData(
      schemaVersion: json['schemaVersion'] is int
          ? json['schemaVersion']
          : currentSchemaVersion,
      gates: List<dynamic>.from(json['gates'] ?? []),
      scopeGroups: List<dynamic>.from(json['scopeGroups'] ?? []),
      etag: json['etag']?.toString(),
      lastSyncedAt: lastSynced,
      gatesSyncedAt: json['gatesSyncedAt'] != null
          ? DateTime.tryParse(json['gatesSyncedAt'].toString())
          : lastSynced,
      scopeGroupsSyncedAt: json['scopeGroupsSyncedAt'] != null
          ? DateTime.tryParse(json['scopeGroupsSyncedAt'].toString())
          : lastSynced,
      hierarchySyncedAt: json['hierarchySyncedAt'] != null
          ? DateTime.tryParse(json['hierarchySyncedAt'].toString())
          : lastSynced,
      isFromCache: true,
      isOutdated: json['isOutdated'] == true,
    );
  }

  LCGatesCacheData copyWith({
    List<dynamic>? gates,
    List<dynamic>? scopeGroups,
    String? etag,
    bool clearEtag = false,
    DateTime? lastSyncedAt,
    DateTime? gatesSyncedAt,
    DateTime? scopeGroupsSyncedAt,
    DateTime? hierarchySyncedAt,
    bool? isFromCache,
    bool? isOutdated,
  }) {
    return LCGatesCacheData(
      schemaVersion: schemaVersion,
      gates: gates ?? this.gates,
      scopeGroups: scopeGroups ?? this.scopeGroups,
      etag: clearEtag ? null : (etag ?? this.etag),
      lastSyncedAt: lastSyncedAt ?? this.lastSyncedAt,
      gatesSyncedAt: gatesSyncedAt ?? this.gatesSyncedAt,
      scopeGroupsSyncedAt: scopeGroupsSyncedAt ?? this.scopeGroupsSyncedAt,
      hierarchySyncedAt: hierarchySyncedAt ?? this.hierarchySyncedAt,
      isFromCache: isFromCache ?? this.isFromCache,
      isOutdated: isOutdated ?? this.isOutdated,
    );
  }
}

enum LCGatesSyncStatus {
  success,     // 200 OK with fresh data
  notModified, // 304 Not Modified
  offline,     // Network failure, using cached data
  error,       // Server returned error status
}

class LCGatesSyncResult {
  final LCGatesSyncStatus status;
  final LCGatesCacheData? data;
  final String? errorMessage;
  final bool isUsingCache;
  final bool isOutdated;

  LCGatesSyncResult({
    required this.status,
    this.data,
    this.errorMessage,
    this.isUsingCache = false,
    this.isOutdated = false,
  });
}

class LCGatesCacheService {
  static const int schemaVersion = 2;
  static final LCGatesCacheService instance = LCGatesCacheService._internal();
  LCGatesCacheService._internal();

  // Cache TTL Configuration
  static const Duration gateMetadataTTL = Duration(minutes: 15);
  static const Duration scopeGroupsTTL = Duration(minutes: 30);
  static const Duration hierarchyTTL = Duration(hours: 2);
  static const Duration deviceStatusTTL = Duration(seconds: 45);

  // In-memory cache for synchronous < 30ms render
  final Map<String, LCGatesCacheData> _memoryCache = {};
  final Map<int, GateStatusItem> _statusCache = {};
  DateTime? _lastStatusVerifiedAt;

  // Request deduplication maps
  final Map<String, Future<LCGatesSyncResult>> _inFlightSyncs = {};
  Future<Map<int, GateStatusItem>>? _inFlightStatusSync;

  String _cacheKey(String userId) => 'lc_gates_dir_v${schemaVersion}_${userId.trim()}';

  /// Synchronous instant read from in-memory cache
  LCGatesCacheData? getMemoryCachedDirectory(String userId) => _memoryCache[userId];

  /// Get cached dynamic status for a specific gate
  GateStatusItem? getGateStatus(int gateId) => _statusCache[gateId];

  /// Get all cached gate statuses
  Map<int, GateStatusItem> getAllStatuses() => Map.unmodifiable(_statusCache);

  DateTime? get lastStatusVerifiedAt => _lastStatusVerifiedAt;

  /// Check if gate metadata is within 15-minute TTL
  bool isGateMetadataFresh(String userId) {
    final cached = _memoryCache[userId];
    if (cached == null || cached.etag == null) return false;
    final time = cached.gatesSyncedAt ?? cached.lastSyncedAt;
    return DateTime.now().difference(time) < gateMetadataTTL;
  }

  /// Check if scope groups are within 30-minute TTL
  bool isScopeGroupsFresh(String userId) {
    final cached = _memoryCache[userId];
    if (cached == null) return false;
    final time = cached.scopeGroupsSyncedAt ?? cached.lastSyncedAt;
    return DateTime.now().difference(time) < scopeGroupsTTL;
  }

  /// Check if device status is within 45-second TTL
  bool isDeviceStatusFresh() {
    if (_lastStatusVerifiedAt == null || _statusCache.isEmpty) return false;
    return DateTime.now().difference(_lastStatusVerifiedAt!) < deviceStatusTTL;
  }

  /// Load cached data from memory or SharedPreferences with corruption protection
  Future<LCGatesCacheData?> getCachedDirectory(String userId) async {
    if (_memoryCache.containsKey(userId)) {
      return _memoryCache[userId];
    }

    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_cacheKey(userId));
      if (raw != null && raw.isNotEmpty) {
        final map = json.decode(raw);
        if (map is Map<String, dynamic> && map['schemaVersion'] == schemaVersion) {
          final cached = LCGatesCacheData.fromJson(map);
          _memoryCache[userId] = cached;
          return cached;
        }
      }
    } catch (e) {
      debugPrint('[LCGatesCacheService] Corrupted cache detected, resetting: $e');
      await hardClear(userId);
    }
    return null;
  }

  /// Deduplicated Intelligent Synchronization with Backend for Directory & Hierarchy
  Future<LCGatesSyncResult> syncDirectory({
    required String userId,
    required String token,
    bool forceReload = false,
  }) {
    if (_inFlightSyncs.containsKey(userId)) {
      return _inFlightSyncs[userId]!;
    }

    final future = _executeDirectorySync(
      userId: userId,
      token: token,
      forceReload: forceReload,
    );

    _inFlightSyncs[userId] = future;
    future.whenComplete(() {
      _inFlightSyncs.remove(userId);
    });

    return future;
  }

  Future<LCGatesSyncResult> _executeDirectorySync({
    required String userId,
    required String token,
    required bool forceReload,
  }) async {
    LCGatesCacheData? cached = await getCachedDirectory(userId);

    // TTL Enforcement: If cache is valid and not forced to reload, avoid redundant API call
    if (!forceReload && cached != null && isGateMetadataFresh(userId) && isScopeGroupsFresh(userId)) {
      return LCGatesSyncResult(
        status: LCGatesSyncStatus.success,
        data: cached,
        isUsingCache: true,
        isOutdated: false,
      );
    }

    final headers = <String, String>{
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $token',
    };

    if (cached != null && cached.etag != null && !forceReload) {
      headers['If-None-Match'] = cached.etag!;
    }

    try {
      // 1. Concurrently fetch scope hierarchy and gates list
      final scopeFuture = http.get(
        Uri.parse('$baseUrl/scope-groups/my-scope'),
        headers: headers,
      ).timeout(const Duration(seconds: 10)).catchError((_) => http.Response('{}', 500));

      final groupsListFuture = http.get(
        Uri.parse('$baseUrl/scope-groups'),
        headers: headers,
      ).timeout(const Duration(seconds: 10)).catchError((_) => http.Response('[]', 500));

      final gatesFuture = http.get(
        Uri.parse('$baseUrl/lcgate'),
        headers: headers,
      ).timeout(const Duration(seconds: 12));

      final results = await Future.wait([scopeFuture, groupsListFuture, gatesFuture]);
      final scopeRes = results[0];
      final groupsListRes = results[1];
      final gatesRes = results[2];

      // Handle Scope Groups response
      List<dynamic> resolvedGroups = cached?.scopeGroups ?? [];
      final now = DateTime.now();
      try {
        List<dynamic> myGroups = [];
        if (scopeRes.statusCode == 200) {
          final dynamic sData = json.decode(scopeRes.body);
          if (sData is Map) {
            myGroups = List.from(sData['allScopeGroups'] ?? sData['scopeGroups'] ?? []);
          }
        }
        if (groupsListRes.statusCode == 200) {
          final dynamic gData = json.decode(groupsListRes.body);
          if (gData is List && gData.isNotEmpty) {
            resolvedGroups = gData;
          } else if (myGroups.isNotEmpty) {
            resolvedGroups = myGroups;
          }
        } else if (myGroups.isNotEmpty) {
          resolvedGroups = myGroups;
        }
      } catch (_) {}

      // SAFE HTTP 304 HANDLING: Server confirms directory has not changed
      if (gatesRes.statusCode == 304 && cached != null) {
        final updated = cached.copyWith(
          scopeGroups: resolvedGroups.isNotEmpty ? resolvedGroups : cached.scopeGroups,
          lastSyncedAt: now,
          gatesSyncedAt: now,
          scopeGroupsSyncedAt: now,
          isFromCache: false,
          isOutdated: false,
        );
        _memoryCache[userId] = updated;
        _saveToDisk(userId, updated);
        return LCGatesSyncResult(
          status: LCGatesSyncStatus.notModified,
          data: updated,
          isUsingCache: true,
          isOutdated: false,
        );
      }

      // HTTP 200 OK: Fresh gate directory data returned
      if (gatesRes.statusCode == 200) {
        final dynamic decoded = json.decode(gatesRes.body);
        if (decoded is List) {
          final serverEtag = gatesRes.headers['etag'];
          final freshData = LCGatesCacheData(
            schemaVersion: schemaVersion,
            gates: decoded,
            scopeGroups: resolvedGroups,
            etag: serverEtag,
            lastSyncedAt: now,
            gatesSyncedAt: now,
            scopeGroupsSyncedAt: now,
            hierarchySyncedAt: now,
            isFromCache: false,
            isOutdated: false,
          );
          _memoryCache[userId] = freshData;
          _saveToDisk(userId, freshData);
          return LCGatesSyncResult(
            status: LCGatesSyncStatus.success,
            data: freshData,
            isUsingCache: false,
            isOutdated: false,
          );
        }
      }

      if (cached != null) {
        final outdatedData = cached.copyWith(isOutdated: true);
        return LCGatesSyncResult(
          status: LCGatesSyncStatus.offline,
          data: outdatedData,
          errorMessage: 'Server status ${gatesRes.statusCode}',
          isUsingCache: true,
          isOutdated: true,
        );
      }

      return LCGatesSyncResult(
        status: LCGatesSyncStatus.error,
        errorMessage: 'Server error: ${gatesRes.statusCode}',
      );
    } catch (e) {
      if (cached != null) {
        final outdatedData = cached.copyWith(isOutdated: true);
        return LCGatesSyncResult(
          status: LCGatesSyncStatus.offline,
          data: outdatedData,
          errorMessage: e.toString(),
          isUsingCache: true,
          isOutdated: true,
        );
      }
      return LCGatesSyncResult(
        status: LCGatesSyncStatus.error,
        errorMessage: e.toString(),
      );
    }
  }

  /// Independent Dynamic Device Status Synchronization
  Future<Map<int, GateStatusItem>> syncStatusSummary({
    required String token,
    bool forceReload = false,
  }) {
    if (!forceReload && isDeviceStatusFresh()) {
      return Future.value(Map.unmodifiable(_statusCache));
    }

    if (_inFlightStatusSync != null) {
      return _inFlightStatusSync!;
    }

    final future = _executeStatusSync(token);
    _inFlightStatusSync = future;
    future.whenComplete(() {
      _inFlightStatusSync = null;
    });

    return future;
  }

  Future<Map<int, GateStatusItem>> _executeStatusSync(String token) async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/status-summary'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      ).timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        final dynamic decoded = json.decode(res.body);
        if (decoded is Map<String, dynamic> && decoded['statuses'] is List) {
          final List list = decoded['statuses'];
          for (final item in list) {
            if (item is Map<String, dynamic>) {
              final statusObj = GateStatusItem.fromJson(item);
              _statusCache[statusObj.gateId] = statusObj;
            }
          }
          _lastStatusVerifiedAt = DateTime.now();
        }
      }
    } catch (e) {
      debugPrint('[LCGatesCacheService] Status-summary sync failed: $e');
    }
    return Map.unmodifiable(_statusCache);
  }

  /// Invalidation Mode 1: Patch an individual gate record in-memory and on-disk
  Future<void> patchGate(String userId, Map<String, dynamic> updatedGate) async {
    final current = _memoryCache[userId];
    if (current == null) return;

    final targetId = updatedGate['id'];
    final list = List<dynamic>.from(current.gates);
    final idx = list.indexWhere((g) => g is Map && g['id'] == targetId);

    if (idx != -1) {
      list[idx] = updatedGate;
    } else {
      list.insert(0, updatedGate);
    }

    final updated = current.copyWith(gates: list);
    _memoryCache[userId] = updated;
    await _saveToDisk(userId, updated);
  }

  /// Invalidation Mode 1: Remove an individual gate record
  Future<void> removeGate(String userId, int gateId) async {
    final current = _memoryCache[userId];
    if (current == null) return;

    final list = List<dynamic>.from(current.gates);
    list.removeWhere((g) => g is Map && g['id'] == gateId);

    final updated = current.copyWith(gates: list);
    _memoryCache[userId] = updated;
    await _saveToDisk(userId, updated);
  }

  /// Invalidation Mode 2: Mark directory stale (clears ETag and resets sync time to force revalidation)
  Future<void> markStale(String userId) async {
    final current = _memoryCache[userId];
    if (current != null) {
      final stale = current.copyWith(
        clearEtag: true,
        gatesSyncedAt: DateTime.fromMillisecondsSinceEpoch(0),
        scopeGroupsSyncedAt: DateTime.fromMillisecondsSinceEpoch(0),
      );
      _memoryCache[userId] = stale;
      await _saveToDisk(userId, stale);
    }
  }

  /// Invalidation Mode 3: Hard Clear user-specific cache on logout or account switch
  Future<void> hardClear(String userId) async {
    _memoryCache.remove(userId);
    _statusCache.clear();
    _lastStatusVerifiedAt = null;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_cacheKey(userId));
    } catch (_) {}
  }

  /// Clear all LC Gate caches on user logout
  Future<void> clearAllUserCaches() async {
    _memoryCache.clear();
    _statusCache.clear();
    _lastStatusVerifiedAt = null;
    try {
      final prefs = await SharedPreferences.getInstance();
      final keys = prefs.getKeys().where((k) => k.startsWith('lc_gates_dir_v'));
      for (final k in keys) {
        await prefs.remove(k);
      }
    } catch (_) {}
  }

  Future<void> _saveToDisk(String userId, LCGatesCacheData data) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_cacheKey(userId), json.encode(data.toJson()));
    } catch (e) {
      debugPrint('[LCGatesCacheService] Failed persisting to SharedPreferences: $e');
    }
  }
}
