import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Authoritative Report Metrics from backend
class AuthoritativeReportMetrics {
  final int totalOperations;
  final int totalDurationSeconds;
  final String totalDurationFormatted;
  final int avgDurationSeconds;
  final String avgDurationFormatted;
  final int extendedDelaysCount;
  final int currentlyOpenCount;
  final int reportingGatesCount;

  AuthoritativeReportMetrics({
    required this.totalOperations,
    required this.totalDurationSeconds,
    required this.totalDurationFormatted,
    required this.avgDurationSeconds,
    required this.avgDurationFormatted,
    required this.extendedDelaysCount,
    required this.currentlyOpenCount,
    this.reportingGatesCount = 0,
  });

  factory AuthoritativeReportMetrics.fromJson(Map<String, dynamic> json) {
    return AuthoritativeReportMetrics(
      totalOperations: json['totalOperations'] is int
          ? json['totalOperations']
          : int.tryParse(json['totalOperations']?.toString() ?? '0') ?? 0,
      totalDurationSeconds: json['totalDurationSeconds'] is int
          ? json['totalDurationSeconds']
          : int.tryParse(json['totalDurationSeconds']?.toString() ?? '0') ?? 0,
      totalDurationFormatted: json['totalDurationFormatted']?.toString() ?? '0s',
      avgDurationSeconds: json['avgDurationSeconds'] is int
          ? json['avgDurationSeconds']
          : int.tryParse(json['avgDurationSeconds']?.toString() ?? '0') ?? 0,
      avgDurationFormatted: json['avgDurationFormatted']?.toString() ?? '0s',
      extendedDelaysCount: json['extendedDelaysCount'] is int
          ? json['extendedDelaysCount']
          : int.tryParse(json['extendedDelaysCount']?.toString() ?? '0') ?? 0,
      currentlyOpenCount: json['currentlyOpenCount'] is int
          ? json['currentlyOpenCount']
          : int.tryParse(json['currentlyOpenCount']?.toString() ?? '0') ?? 0,
      reportingGatesCount: json['reportingGatesCount'] is int
          ? json['reportingGatesCount']
          : int.tryParse(json['reportingGatesCount']?.toString() ?? '0') ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
        'totalOperations': totalOperations,
        'totalDurationSeconds': totalDurationSeconds,
        'totalDurationFormatted': totalDurationFormatted,
        'avgDurationSeconds': avgDurationSeconds,
        'avgDurationFormatted': avgDurationFormatted,
        'extendedDelaysCount': extendedDelaysCount,
        'currentlyOpenCount': currentlyOpenCount,
        'reportingGatesCount': reportingGatesCount,
      };
}

/// Synchronization Cursors
class ReportsCursor {
  final String eventCursorTime;
  final int eventCursorId;
  final String tombstoneCursorId;
  final Map<String, String> gateRevisions;
  final bool hasUnclosedEvents;
  final String serverTime;

  ReportsCursor({
    required this.eventCursorTime,
    required this.eventCursorId,
    required this.tombstoneCursorId,
    required this.gateRevisions,
    this.hasUnclosedEvents = false,
    required this.serverTime,
  });

  factory ReportsCursor.fromJson(Map<String, dynamic> json) {
    final rawRevs = json['gateRevisions'];
    final revMap = <String, String>{};
    if (rawRevs is Map) {
      rawRevs.forEach((k, v) {
        revMap[k.toString()] = v.toString();
      });
    }

    return ReportsCursor(
      eventCursorTime: json['eventCursorTime']?.toString() ?? '',
      eventCursorId: json['eventCursorId'] is int
          ? json['eventCursorId']
          : int.tryParse(json['eventCursorId']?.toString() ?? '0') ?? 0,
      tombstoneCursorId: json['tombstoneCursorId']?.toString() ?? '0',
      gateRevisions: revMap,
      hasUnclosedEvents: json['hasUnclosedEvents'] == true,
      serverTime: json['serverTime']?.toString() ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
        'eventCursorTime': eventCursorTime,
        'eventCursorId': eventCursorId,
        'tombstoneCursorId': tombstoneCursorId,
        'gateRevisions': gateRevisions,
        'hasUnclosedEvents': hasUnclosedEvents,
        'serverTime': serverTime,
      };

  ReportsCursor copyWith({
    String? eventCursorTime,
    int? eventCursorId,
    String? tombstoneCursorId,
    Map<String, String>? gateRevisions,
    bool? hasUnclosedEvents,
    String? serverTime,
  }) {
    return ReportsCursor(
      eventCursorTime: eventCursorTime ?? this.eventCursorTime,
      eventCursorId: eventCursorId ?? this.eventCursorId,
      tombstoneCursorId: tombstoneCursorId ?? this.tombstoneCursorId,
      gateRevisions: gateRevisions ?? this.gateRevisions,
      hasUnclosedEvents: hasUnclosedEvents ?? this.hasUnclosedEvents,
      serverTime: serverTime ?? this.serverTime,
    );
  }
}

/// Operational Event Record Model
class OperationalRecord {
  final int id;
  final int gateId;
  final String lcNumber;
  final String gateName;
  final String locationName;
  final String? zone;
  final String? division;
  final String scopeGroupName;
  final String scopeGroupColor;
  final String openedAt;
  final String? closedAt;
  final int? durationSeconds;
  final String durationFormatted;
  final String status; // OPEN, CLOSED, EXTENDED_DELAY
  final String? openedBy;
  final String? closedBy;
  final String? trainNumber;
  final String? remarks;

  OperationalRecord({
    required this.id,
    required this.gateId,
    required this.lcNumber,
    required this.gateName,
    required this.locationName,
    this.zone,
    this.division,
    required this.scopeGroupName,
    required this.scopeGroupColor,
    required this.openedAt,
    this.closedAt,
    this.durationSeconds,
    required this.durationFormatted,
    required this.status,
    this.openedBy,
    this.closedBy,
    this.trainNumber,
    this.remarks,
  });

  factory OperationalRecord.fromJson(Map<String, dynamic> json) {
    return OperationalRecord(
      id: json['id'] is int ? json['id'] : int.tryParse(json['id']?.toString() ?? '0') ?? 0,
      gateId: json['gateId'] is int ? json['gateId'] : int.tryParse(json['gateId']?.toString() ?? '0') ?? 0,
      lcNumber: json['lcNumber']?.toString() ?? 'LC-GATE',
      gateName: json['gateName']?.toString() ?? json['locationName']?.toString() ?? 'Gate',
      locationName: json['locationName']?.toString() ?? 'Location',
      zone: json['zone']?.toString(),
      division: json['division']?.toString(),
      scopeGroupName: json['scopeGroupName']?.toString() ?? 'Unassigned',
      scopeGroupColor: json['scopeGroupColor']?.toString() ?? '#0B3C7A',
      openedAt: json['openedAt']?.toString() ?? DateTime.now().toIso8601String(),
      closedAt: json['closedAt']?.toString(),
      durationSeconds: json['durationSeconds'] is int
          ? json['durationSeconds']
          : int.tryParse(json['durationSeconds']?.toString() ?? ''),
      durationFormatted: json['durationFormatted']?.toString() ?? 'Ongoing (Open)',
      status: json['status']?.toString().toUpperCase() ?? 'CLOSED',
      openedBy: json['openedBy']?.toString(),
      closedBy: json['closedBy']?.toString(),
      trainNumber: json['trainNumber']?.toString(),
      remarks: json['remarks']?.toString(),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'gateId': gateId,
        'lcNumber': lcNumber,
        'gateName': gateName,
        'locationName': locationName,
        'zone': zone,
        'division': division,
        'scopeGroupName': scopeGroupName,
        'scopeGroupColor': scopeGroupColor,
        'openedAt': openedAt,
        'closedAt': closedAt,
        'durationSeconds': durationSeconds,
        'durationFormatted': durationFormatted,
        'status': status,
        'openedBy': openedBy,
        'closedBy': closedBy,
        'trainNumber': trainNumber,
        'remarks': remarks,
      };
}

/// Report Filter Parameters used for Canonical Key Generation & Filter Evaluation
class ReportFilterParams {
  final List<int> scopeGroupIds;
  final List<int> gateIds;
  final String startDate; // YYYY-MM-DD
  final String endDate;   // YYYY-MM-DD
  final String status;    // ALL, OPEN, CLOSED, EXTENDED_DELAY
  final String shift;     // ALL, MORNING, EVENING, NIGHT
  final String search;
  final String sortBy;
  final String sortOrder; // asc, desc

  ReportFilterParams({
    this.scopeGroupIds = const [],
    this.gateIds = const [],
    required this.startDate,
    required this.endDate,
    this.status = 'ALL',
    this.shift = 'ALL',
    this.search = '',
    this.sortBy = 'openedAt',
    this.sortOrder = 'desc',
  });
}

/// Complete Persistent Cache Entry
class ReportsCacheEntry {
  final String userId;
  final String canonicalKey;
  final List<OperationalRecord> records;
  final AuthoritativeReportMetrics? authoritativeMetrics;
  final String? etag;
  final ReportsCursor cursor;
  final DateTime cachedAt;
  DateTime verifiedAt;
  final Duration ttl;
  final bool isComplete;
  final bool isTruncated;
  final int totalRecordCount;
  final int cachedRecordCount;
  final int schemaVersion;

  ReportsCacheEntry({
    required this.userId,
    required this.canonicalKey,
    required this.records,
    this.authoritativeMetrics,
    this.etag,
    required this.cursor,
    required this.cachedAt,
    required this.verifiedAt,
    required this.ttl,
    this.isComplete = true,
    this.isTruncated = false,
    required this.totalRecordCount,
    required this.cachedRecordCount,
    this.schemaVersion = ReportsCacheService.currentSchemaVersion,
  });

  bool get isFresh => DateTime.now().difference(verifiedAt) < ttl;
  bool get isStale => !isFresh;

  ReportsCacheEntry copyWith({
    String? userId,
    String? canonicalKey,
    List<OperationalRecord>? records,
    AuthoritativeReportMetrics? authoritativeMetrics,
    String? etag,
    ReportsCursor? cursor,
    DateTime? cachedAt,
    DateTime? verifiedAt,
    Duration? ttl,
    bool? isComplete,
    bool? isTruncated,
    int? totalRecordCount,
    int? cachedRecordCount,
    int? schemaVersion,
  }) {
    return ReportsCacheEntry(
      userId: userId ?? this.userId,
      canonicalKey: canonicalKey ?? this.canonicalKey,
      records: records ?? this.records,
      authoritativeMetrics: authoritativeMetrics ?? this.authoritativeMetrics,
      etag: etag ?? this.etag,
      cursor: cursor ?? this.cursor,
      cachedAt: cachedAt ?? this.cachedAt,
      verifiedAt: verifiedAt ?? this.verifiedAt,
      ttl: ttl ?? this.ttl,
      isComplete: isComplete ?? this.isComplete,
      isTruncated: isTruncated ?? this.isTruncated,
      totalRecordCount: totalRecordCount ?? this.totalRecordCount,
      cachedRecordCount: cachedRecordCount ?? this.cachedRecordCount,
      schemaVersion: schemaVersion ?? this.schemaVersion,
    );
  }

  factory ReportsCacheEntry.fromJson(Map<String, dynamic> json) {
    final recList = (json['records'] as List? ?? [])
        .map((r) => OperationalRecord.fromJson(r as Map<String, dynamic>))
        .toList();

    return ReportsCacheEntry(
      userId: json['userId']?.toString() ?? '',
      canonicalKey: json['canonicalKey']?.toString() ?? '',
      records: recList,
      authoritativeMetrics: json['authoritativeMetrics'] != null
          ? AuthoritativeReportMetrics.fromJson(json['authoritativeMetrics'] as Map<String, dynamic>)
          : null,
      etag: json['etag']?.toString(),
      cursor: json['cursor'] != null
          ? ReportsCursor.fromJson(json['cursor'] as Map<String, dynamic>)
          : ReportsCursor(eventCursorTime: '', eventCursorId: 0, tombstoneCursorId: '0', gateRevisions: {}, serverTime: ''),
      cachedAt: DateTime.tryParse(json['cachedAt']?.toString() ?? '') ?? DateTime.now(),
      verifiedAt: DateTime.tryParse(json['verifiedAt']?.toString() ?? '') ?? DateTime.now(),
      ttl: Duration(milliseconds: json['ttlMs'] is int ? json['ttlMs'] : 120000),
      isComplete: json['isComplete'] == true,
      isTruncated: json['isTruncated'] == true,
      totalRecordCount: json['totalRecordCount'] is int ? json['totalRecordCount'] : recList.length,
      cachedRecordCount: json['cachedRecordCount'] is int ? json['cachedRecordCount'] : recList.length,
      schemaVersion: json['schemaVersion'] is int ? json['schemaVersion'] : 1,
    );
  }

  Map<String, dynamic> toJson() => {
        'userId': userId,
        'canonicalKey': canonicalKey,
        'records': records.map((r) => r.toJson()).toList(),
        'authoritativeMetrics': authoritativeMetrics?.toJson(),
        'etag': etag,
        'cursor': cursor.toJson(),
        'cachedAt': cachedAt.toIso8601String(),
        'verifiedAt': verifiedAt.toIso8601String(),
        'ttlMs': ttl.inMilliseconds,
        'isComplete': isComplete,
        'isTruncated': isTruncated,
        'totalRecordCount': totalRecordCount,
        'cachedRecordCount': cachedRecordCount,
        'schemaVersion': schemaVersion,
      };
}

/// Hierarchy Cache for /api/v1/reports/clusters (30-Minute TTL)
class ReportsHierarchyCache {
  final int schemaVersion;
  final List<dynamic> clusters;
  final bool isDeveloper;
  final String? etag;
  final DateTime cachedAt;
  DateTime verifiedAt;

  ReportsHierarchyCache({
    this.schemaVersion = ReportsCacheService.currentSchemaVersion,
    required this.clusters,
    required this.isDeveloper,
    this.etag,
    required this.cachedAt,
    required this.verifiedAt,
  });

  bool get isFresh => DateTime.now().difference(verifiedAt) < ReportsCacheService.hierarchyTtl;

  factory ReportsHierarchyCache.fromJson(Map<String, dynamic> json) {
    return ReportsHierarchyCache(
      schemaVersion: json['schemaVersion'] is int ? json['schemaVersion'] : 1,
      clusters: (json['clusters'] as List?) ?? [],
      isDeveloper: json['isDeveloper'] == true,
      etag: json['etag']?.toString(),
      cachedAt: DateTime.tryParse(json['cachedAt']?.toString() ?? '') ?? DateTime.now(),
      verifiedAt: DateTime.tryParse(json['verifiedAt']?.toString() ?? '') ?? DateTime.now(),
    );
  }

  Map<String, dynamic> toJson() => {
        'schemaVersion': schemaVersion,
        'clusters': clusters,
        'isDeveloper': isDeveloper,
        'etag': etag,
        'cachedAt': cachedAt.toIso8601String(),
        'verifiedAt': verifiedAt.toIso8601String(),
      };
}

/// Incremental Changes Response Payload
class IncrementalChangesPayload {
  final bool requiresFullSync;
  final String? resyncReason;
  final List<OperationalRecord> events;
  final List<int> deletions;
  final bool hasMoreEvents;
  final Map<String, String>? gateRevisions;
  final bool? hasUnclosedEvents;
  final AuthoritativeReportMetrics? authoritativeMetrics;
  final String serverTime;

  IncrementalChangesPayload({
    required this.requiresFullSync,
    this.resyncReason,
    required this.events,
    required this.deletions,
    required this.hasMoreEvents,
    this.gateRevisions,
    this.hasUnclosedEvents,
    this.authoritativeMetrics,
    required this.serverTime,
  });

  factory IncrementalChangesPayload.fromJson(Map<String, dynamic> json) {
    final rawEvents = (json['events'] as List? ?? [])
        .map((e) => OperationalRecord.fromJson(e as Map<String, dynamic>))
        .toList();

    final rawDeletions = (json['deletions'] as List? ?? [])
        .map((d) => d is int ? d : int.tryParse(d.toString()) ?? 0)
        .where((d) => d > 0)
        .toList();

    Map<String, String>? revMap;
    if (json['gateRevisions'] is Map) {
      revMap = {};
      (json['gateRevisions'] as Map).forEach((k, v) {
        revMap![k.toString()] = v.toString();
      });
    }

    return IncrementalChangesPayload(
      requiresFullSync: json['requiresFullSync'] == true,
      resyncReason: json['resyncReason']?.toString(),
      events: rawEvents,
      deletions: rawDeletions,
      hasMoreEvents: json['hasMoreEvents'] == true,
      gateRevisions: revMap,
      hasUnclosedEvents: json['hasUnclosedEvents'] as bool?,
      authoritativeMetrics: json['authoritativeMetrics'] != null
          ? AuthoritativeReportMetrics.fromJson(json['authoritativeMetrics'] as Map<String, dynamic>)
          : null,
      serverTime: json['serverTime']?.toString() ?? DateTime.now().toIso8601String(),
    );
  }
}

/// Dedicated Flutter Intelligent Cache Service for Operational Reports
class ReportsCacheService {
  ReportsCacheService._internal();
  static final ReportsCacheService instance = ReportsCacheService._internal();

  static const int currentSchemaVersion = 1;

  // TTL Configurations
  static const Duration freshReportTtl = Duration(minutes: 2);
  static const Duration historicalReportTtl = Duration(minutes: 15);
  static const Duration hierarchyTtl = Duration(minutes: 30);

  // Storage Limits
  static const int maxMemoryEntries = 30;
  static const int maxPersistentEntries = 10;

  // Level 1 In-Memory Caches
  final Map<String, ReportsCacheEntry> _memoryCache = {};
  final Map<String, ReportsHierarchyCache> _hierarchyMemoryCache = {};

  // ──────────────────────────────────────────────────────────────────────────
  // CANONICAL KEY GENERATOR (MATCHES REACT WEB & BACKEND SPECIFICATION)
  // ──────────────────────────────────────────────────────────────────────────
  String generateCanonicalKey(dynamic userId, ReportFilterParams params) {
    final normScope = params.scopeGroupIds.isNotEmpty
        ? (List<int>.from(params.scopeGroupIds)..sort()).join(',')
        : 'all';
    final normGates = params.gateIds.isNotEmpty
        ? (List<int>.from(params.gateIds)..sort()).join(',')
        : 'all';
    final normStart = params.startDate.trim();
    final normEnd = params.endDate.trim();
    final normStatus = params.status.trim().toUpperCase();
    final normShift = params.shift.trim().toUpperCase();
    final normSearch = params.search.trim().toLowerCase();
    final normSortBy = params.sortBy.trim().isEmpty ? 'openedAt' : params.sortBy.trim();
    final normSortOrder = params.sortOrder.trim().toLowerCase() == 'asc' ? 'asc' : 'desc';

    return 'u:$userId|sg:$normScope|g:$normGates|s:$normStart|e:$normEnd|st:$normStatus|sh:$normShift|q:$normSearch|sb:$normSortBy|so:$normSortOrder';
  }

  String _cleanHash(String str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.codeUnitAt(i);
      hash &= 0x7FFFFFFF;
    }
    return hash.toRadixString(36);
  }

  String _getStorageKey(dynamic userId, String canonicalKey) {
    return 'lc_rep_v${currentSchemaVersion}_${userId}_${_cleanHash(canonicalKey)}';
  }

  String _getIndexKey(dynamic userId) {
    return 'lc_rep_idx_v${currentSchemaVersion}_$userId';
  }

  String _getHierarchyStorageKey(dynamic userId) {
    return 'lc_rep_hier_v${currentSchemaVersion}_$userId';
  }

  // ──────────────────────────────────────────────────────────────────────────
  // REPORT CACHE READ / WRITE / SWR
  // ──────────────────────────────────────────────────────────────────────────

  /// Synchronous retrieval from in-memory LRU Map (< 0.1ms)
  ReportsCacheEntry? getMemoryCachedReport(dynamic userId, ReportFilterParams params) {
    final key = generateCanonicalKey(userId, params);
    if (_memoryCache.containsKey(key)) {
      final entry = _memoryCache.remove(key)!;
      _memoryCache[key] = entry; // Move to end (LRU bump)
      return entry;
    }
    return null;
  }

  /// Two-level retrieval: checks memory first, then persistent SharedPreferences
  Future<ReportsCacheEntry?> getCachedReport(dynamic userId, ReportFilterParams params) async {
    final key = generateCanonicalKey(userId, params);

    // 1. Memory read
    if (_memoryCache.containsKey(key)) {
      final entry = _memoryCache.remove(key)!;
      _memoryCache[key] = entry;
      return entry;
    }

    // 2. Persistent storage read
    try {
      final prefs = await SharedPreferences.getInstance();
      final storageKey = _getStorageKey(userId, key);
      final raw = prefs.getString(storageKey);
      if (raw != null) {
        final parsed = json.decode(raw);
        if (parsed is Map<String, dynamic> &&
            parsed['schemaVersion'] == currentSchemaVersion &&
            parsed['canonicalKey'] == key &&
            parsed['records'] is List) {
          final entry = ReportsCacheEntry.fromJson(parsed);
          _setMemoryCache(key, entry);
          return entry;
        }
      }
    } catch (e) {
      debugPrint('[ReportsCacheService] Corrupted persistent cache for key $key: $e');
    }

    return null;
  }

  /// Saves a fresh report snapshot into Memory and Persistent SharedPreferences
  Future<void> saveReport(
    dynamic userId,
    ReportFilterParams params, {
    required List<OperationalRecord> records,
    AuthoritativeReportMetrics? metrics,
    String? etag,
    required ReportsCursor cursor,
    Duration? ttl,
  }) async {
    final key = generateCanonicalKey(userId, params);
    final now = DateTime.now();

    // Determine appropriate TTL
    final isHistorical = !params.endDate.contains(now.toIso8601String().split('T').first);
    final effectiveTtl = ttl ?? (isHistorical ? historicalReportTtl : freshReportTtl);

    final entry = ReportsCacheEntry(
      userId: userId.toString(),
      canonicalKey: key,
      records: records,
      authoritativeMetrics: metrics,
      etag: etag,
      cursor: cursor,
      cachedAt: now,
      verifiedAt: now,
      ttl: effectiveTtl,
      isComplete: true,
      isTruncated: false,
      totalRecordCount: records.length,
      cachedRecordCount: records.length,
    );

    // Write Level 1 Memory
    _setMemoryCache(key, entry);

    // Write Level 2 Persistent Storage
    try {
      final prefs = await SharedPreferences.getInstance();
      final storageKey = _getStorageKey(userId, key);
      final indexKey = _getIndexKey(userId);

      // Read persistent LRU index
      List<String> indexList = [];
      final rawIdx = prefs.getString(indexKey);
      if (rawIdx != null) {
        try {
          final parsed = json.decode(rawIdx);
          if (parsed is List) indexList = parsed.map((e) => e.toString()).toList();
        } catch (_) {}
      }

      indexList.remove(storageKey);
      indexList.add(storageKey);

      // Evict oldest persistent entries if exceeding max limit
      while (indexList.length > maxPersistentEntries) {
        final evicted = indexList.removeAt(0);
        await prefs.remove(evicted);
      }

      await prefs.setString(storageKey, json.encode(entry.toJson()));
      await prefs.setString(indexKey, json.encode(indexList));
    } catch (err) {
      debugPrint('[ReportsCacheService] Error persisting report cache: $err');
    }
  }

  /// Touches verification timestamp on HTTP 304 without wiping data
  Future<void> touchVerified(
    dynamic userId,
    ReportFilterParams params, {
    String? newEtag,
  }) async {
    final key = generateCanonicalKey(userId, params);
    final cached = await getCachedReport(userId, params);
    if (cached == null) return;

    final updated = cached.copyWith(
      verifiedAt: DateTime.now(),
      etag: newEtag ?? cached.etag,
    );
    _setMemoryCache(key, updated);

    try {
      final prefs = await SharedPreferences.getInstance();
      final storageKey = _getStorageKey(userId, key);
      await prefs.setString(storageKey, json.encode(updated.toJson()));
    } catch (_) {}
  }

  /// Applies transactionally serialized ChangeLog mutations with Map-based upserts
  Future<ReportsCacheEntry?> updateIncrementalChanges(
    dynamic userId,
    ReportFilterParams params,
    IncrementalChangesPayload changes,
  ) async {
    final key = generateCanonicalKey(userId, params);
    final cached = await getCachedReport(userId, params);
    if (cached == null) return null;

    // Index existing records by ID
    final map = <int, OperationalRecord>{};
    for (final r in cached.records) {
      map[r.id] = r;
    }

    // 1. Process Deletions
    for (final delId in changes.deletions) {
      map.remove(delId);
    }

    // 2. Process Insertions & In-Place State Updates
    for (final ev in changes.events) {
      if (isRecordMatchingFilters(ev, params)) {
        map[ev.id] = ev;
      } else {
        // If mutated event no longer matches the user's active filter, evict from view
        map.remove(ev.id);
      }
    }

    // 3. Re-sort records deterministically according to active sort params
    final updatedRecords = sortRecords(map.values.toList(), params.sortBy, params.sortOrder);

    // 4. Update Gate Revisions
    final mergedRevs = Map<String, String>.from(cached.cursor.gateRevisions);
    if (changes.gateRevisions != null) {
      changes.gateRevisions!.forEach((k, v) {
        mergedRevs[k] = v;
      });
    }

    final updatedCursor = cached.cursor.copyWith(
      gateRevisions: mergedRevs,
      hasUnclosedEvents: changes.hasUnclosedEvents ?? cached.cursor.hasUnclosedEvents,
      serverTime: changes.serverTime,
    );

    final now = DateTime.now();
    final updatedEntry = ReportsCacheEntry(
      userId: userId.toString(),
      canonicalKey: key,
      records: updatedRecords,
      authoritativeMetrics: changes.authoritativeMetrics ?? cached.authoritativeMetrics,
      etag: cached.etag,
      cursor: updatedCursor,
      cachedAt: cached.cachedAt,
      verifiedAt: now,
      ttl: cached.ttl,
      isComplete: true,
      isTruncated: false,
      totalRecordCount: updatedRecords.length,
      cachedRecordCount: updatedRecords.length,
    );

    _setMemoryCache(key, updatedEntry);

    try {
      final prefs = await SharedPreferences.getInstance();
      final storageKey = _getStorageKey(userId, key);
      await prefs.setString(storageKey, json.encode(updatedEntry.toJson()));
    } catch (_) {}

    return updatedEntry;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FILTER MATCHING & IN-MEMORY SORTING (MATCHES BACKEND EXACTLY)
  // ──────────────────────────────────────────────────────────────────────────
  bool isRecordMatchingFilters(OperationalRecord record, ReportFilterParams params) {
    // 1. Status Filter
    final targetStatus = params.status.trim().toUpperCase();
    if (targetStatus != 'ALL' && record.status.toUpperCase() != targetStatus) {
      return false;
    }

    // 2. Target Gate Filter
    if (params.gateIds.isNotEmpty && !params.gateIds.contains(record.gateId)) {
      return false;
    }

    // 3. Date Range Filter (Opened Date must fall within range)
    if (params.startDate.isNotEmpty && params.endDate.isNotEmpty) {
      final opened = DateTime.tryParse(record.openedAt)?.toUtc();
      final start = DateTime.tryParse('${params.startDate}T00:00:00.000Z')?.toUtc();
      final end = DateTime.tryParse('${params.endDate}T23:59:59.999Z')?.toUtc();
      if (opened != null && start != null && end != null) {
        if (opened.isBefore(start) || opened.isAfter(end)) {
          return false;
        }
      }
    }

    // 4. Shift Filter (IST timezone calculation)
    final targetShift = params.shift.trim().toUpperCase();
    if (targetShift != 'ALL') {
      final opened = DateTime.tryParse(record.openedAt);
      if (opened != null) {
        final istTime = opened.toUtc().add(const Duration(hours: 5, minutes: 30));
        final istHour = istTime.hour;
        if (targetShift == 'MORNING' && (istHour < 6 || istHour >= 14)) return false;
        if (targetShift == 'EVENING' && (istHour < 14 || istHour >= 22)) return false;
        if (targetShift == 'NIGHT' && (istHour >= 6 && istHour < 22)) return false;
      }
    }

    // 5. Keyword Search Filter
    if (params.search.trim().isNotEmpty) {
      final q = params.search.trim().toLowerCase();
      final lc = record.lcNumber.toLowerCase();
      final loc = record.locationName.toLowerCase();
      final name = record.gateName.toLowerCase();
      if (!lc.contains(q) && !loc.contains(q) && !name.contains(q)) {
        return false;
      }
    }

    return true;
  }

  List<OperationalRecord> sortRecords(List<OperationalRecord> records, String sortBy, String sortOrder) {
    final list = List<OperationalRecord>.from(records);
    final isAsc = sortOrder.toLowerCase() == 'asc';

    list.sort((a, b) {
      if (sortBy == 'durationSeconds') {
        final durA = a.durationSeconds ?? 0;
        final durB = b.durationSeconds ?? 0;
        return isAsc ? durA.compareTo(durB) : durB.compareTo(durA);
      } else if (sortBy == 'lcNumber') {
        final cmp = a.lcNumber.compareTo(b.lcNumber);
        return isAsc ? cmp : -cmp;
      } else if (sortBy == 'status') {
        final cmp = a.status.compareTo(b.status);
        return isAsc ? cmp : -cmp;
      } else {
        // Default openedAt
        final timeA = DateTime.tryParse(a.openedAt) ?? DateTime(0);
        final timeB = DateTime.tryParse(b.openedAt) ?? DateTime(0);
        return isAsc ? timeA.compareTo(timeB) : timeB.compareTo(timeA);
      }
    });

    return list;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HIERARCHY CACHE (30-MINUTE TTL)
  // ──────────────────────────────────────────────────────────────────────────
  Future<ReportsHierarchyCache?> getCachedHierarchy(dynamic userId) async {
    final uKey = userId.toString();
    // 1. Memory read
    if (_hierarchyMemoryCache.containsKey(uKey)) {
      return _hierarchyMemoryCache[uKey];
    }

    // 2. Persistent read
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_getHierarchyStorageKey(userId));
      if (raw != null) {
        final parsed = json.decode(raw);
        if (parsed is Map<String, dynamic> &&
            parsed['schemaVersion'] == currentSchemaVersion &&
            parsed['clusters'] is List) {
          final cache = ReportsHierarchyCache.fromJson(parsed);
          _hierarchyMemoryCache[uKey] = cache;
          return cache;
        }
      }
    } catch (_) {}

    return null;
  }

  Future<void> saveHierarchy(
    dynamic userId,
    List<dynamic> clusters,
    bool isDeveloper,
    String? etag,
  ) async {
    final uKey = userId.toString();
    final now = DateTime.now();

    final cache = ReportsHierarchyCache(
      clusters: clusters,
      isDeveloper: isDeveloper,
      etag: etag,
      cachedAt: now,
      verifiedAt: now,
    );

    _hierarchyMemoryCache[uKey] = cache;

    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_getHierarchyStorageKey(userId), json.encode(cache.toJson()));
    } catch (_) {}
  }

  Future<void> touchHierarchyVerified(dynamic userId) async {
    final uKey = userId.toString();
    final cache = await getCachedHierarchy(userId);
    if (cache == null) return;

    cache.verifiedAt = DateTime.now();
    _hierarchyMemoryCache[uKey] = cache;

    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_getHierarchyStorageKey(userId), json.encode(cache.toJson()));
    } catch (_) {}
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PURGE & USER ISOLATION
  // ──────────────────────────────────────────────────────────────────────────
  Future<void> clearUserCache(dynamic userId) async {
    final uKey = userId.toString();

    // 1. Clear memory caches
    _memoryCache.removeWhere((k, v) => v.userId == uKey);
    _hierarchyMemoryCache.remove(uKey);

    // 2. Clear persistent storage
    try {
      final prefs = await SharedPreferences.getInstance();
      final indexKey = _getIndexKey(userId);
      final rawIdx = prefs.getString(indexKey);
      if (rawIdx != null) {
        try {
          final list = json.decode(rawIdx);
          if (list is List) {
            for (final k in list) {
              await prefs.remove(k.toString());
            }
          }
        } catch (_) {}
      }
      await prefs.remove(indexKey);
      await prefs.remove(_getHierarchyStorageKey(userId));
    } catch (_) {}
  }

  Future<void> clearAllUserCaches() async {
    _memoryCache.clear();
    _hierarchyMemoryCache.clear();

    try {
      final prefs = await SharedPreferences.getInstance();
      final keys = prefs.getKeys().where((k) => k.startsWith('lc_rep_')).toList();
      for (final k in keys) {
        await prefs.remove(k);
      }
    } catch (_) {}
  }

  /// Clears in-memory caches without affecting persistent SharedPreferences (for testing & low memory simulation)
  void clearMemoryOnly() {
    _memoryCache.clear();
    _hierarchyMemoryCache.clear();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // INTERNAL MEMORY LRU EVICTION
  // ──────────────────────────────────────────────────────────────────────────
  void _setMemoryCache(String key, ReportsCacheEntry entry) {
    if (_memoryCache.containsKey(key)) {
      _memoryCache.remove(key);
    } else if (_memoryCache.length >= maxMemoryEntries) {
      _memoryCache.remove(_memoryCache.keys.first);
    }
    _memoryCache[key] = entry;
  }
}
