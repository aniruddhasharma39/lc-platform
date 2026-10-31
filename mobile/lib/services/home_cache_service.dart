import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';

class HomeCacheData {
  final Map<String, dynamic> data;
  final String? etag;
  final DateTime lastSyncedAt;
  final String cachedDate; // YYYY-MM-DD
  final bool isFromCache;

  HomeCacheData({
    required this.data,
    this.etag,
    required this.lastSyncedAt,
    required this.cachedDate,
    this.isFromCache = false,
  });

  Map<String, dynamic> toJson() => {
    'data': data,
    'etag': etag,
    'lastSyncedAt': lastSyncedAt.toIso8601String(),
    'cachedDate': cachedDate,
  };

  factory HomeCacheData.fromJson(Map<String, dynamic> json) {
    return HomeCacheData(
      data: Map<String, dynamic>.from(json['data'] ?? {}),
      etag: json['etag']?.toString(),
      lastSyncedAt: json['lastSyncedAt'] != null
          ? DateTime.tryParse(json['lastSyncedAt'].toString()) ?? DateTime.now()
          : DateTime.now(),
      cachedDate: json['cachedDate']?.toString() ?? _currentDateString(),
      isFromCache: true,
    );
  }

  static String _currentDateString() {
    final now = DateTime.now();
    return '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
  }
}

enum HomeSyncStatus {
  success,       // 200 OK with fresh data
  notModified,   // 304 Not Modified (cached data confirmed valid)
  offline,       // Network failure, using cached data
  error,         // Error without cached data
}

class HomeSyncResult {
  final HomeSyncStatus status;
  final HomeCacheData? cacheData;
  final String? errorMessage;

  HomeSyncResult({
    required this.status,
    this.cacheData,
    this.errorMessage,
  });
}

class HomeCacheService {
  static final HomeCacheService instance = HomeCacheService._internal();
  HomeCacheService._internal();

  // In-memory cache for 0ms instant display without disk I/O latency
  final Map<String, HomeCacheData> _memoryCache = {};

  // In-flight request deduplication per user
  final Map<String, Future<HomeSyncResult>> _inFlightSyncs = {};

  String _cacheKey(String userId) => 'home_dashboard_cache_${userId.trim()}';

  static String currentDateString() {
    final now = DateTime.now();
    return '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
  }

  /// Instant synchronous read from in-memory cache
  HomeCacheData? getMemoryCachedDashboard(String userId) {
    return _memoryCache[userId];
  }

  /// Load cached data from memory or SharedPreferences
  Future<HomeCacheData?> getCachedDashboard(String userId) async {
    if (_memoryCache.containsKey(userId)) {
      return _memoryCache[userId];
    }

    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_cacheKey(userId));
      if (raw != null && raw.isNotEmpty) {
        final map = json.decode(raw);
        if (map is Map<String, dynamic>) {
          final cached = HomeCacheData.fromJson(map);
          _memoryCache[userId] = cached;
          return cached;
        }
      }
    } catch (e) {
      debugPrint('Error reading Home cache: $e');
    }
    return null;
  }

  /// Save new dashboard data to memory and SharedPreferences
  Future<HomeCacheData> saveDashboard(
    String userId,
    Map<String, dynamic> data, {
    String? etag,
    DateTime? syncedAt,
  }) async {
    final now = syncedAt ?? DateTime.now();
    final cacheData = HomeCacheData(
      data: data,
      etag: etag,
      lastSyncedAt: now,
      cachedDate: currentDateString(),
      isFromCache: false,
    );

    _memoryCache[userId] = cacheData;

    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_cacheKey(userId), json.encode(cacheData.toJson()));
    } catch (e) {
      debugPrint('Error persisting Home cache: $e');
    }

    return cacheData;
  }

  /// Update timestamp and ETag when server confirms 304 Not Modified
  Future<HomeCacheData?> updateSyncTimestamp(
    String userId, {
    String? etag,
    DateTime? syncedAt,
  }) async {
    final current = _memoryCache[userId] ?? await getCachedDashboard(userId);
    if (current == null) return null;

    final updated = HomeCacheData(
      data: current.data,
      etag: etag ?? current.etag,
      lastSyncedAt: syncedAt ?? DateTime.now(),
      cachedDate: currentDateString(),
      isFromCache: false,
    );

    _memoryCache[userId] = updated;

    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_cacheKey(userId), json.encode(updated.toJson()));
    } catch (e) {
      debugPrint('Error updating Home sync timestamp: $e');
    }

    return updated;
  }

  /// Clear user-specific cache on logout or account switch
  Future<void> clearUserCache(String userId) async {
    _memoryCache.remove(userId);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_cacheKey(userId));
    } catch (_) {}
  }

  /// Deduplicated Intelligent Synchronization with Backend
  Future<HomeSyncResult> syncDashboard({
    required String userId,
    required String token,
    bool forceFullReload = false,
  }) {
    // If a sync request is already in-flight for this user, reuse it
    if (_inFlightSyncs.containsKey(userId)) {
      return _inFlightSyncs[userId]!;
    }

    final future = _executeSync(
      userId: userId,
      token: token,
      forceFullReload: forceFullReload,
    );

    _inFlightSyncs[userId] = future;
    future.whenComplete(() {
      _inFlightSyncs.remove(userId);
    });

    return future;
  }

  Future<HomeSyncResult> _executeSync({
    required String userId,
    required String token,
    required bool forceFullReload,
  }) async {
    HomeCacheData? cached = await getCachedDashboard(userId);

    // If date rolled over (e.g., midnight passed), today's cycles need revalidation
    final isRollover = cached != null && cached.cachedDate != currentDateString();

    final headers = <String, String>{
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $token',
    };

    // Use conditional HTTP validator (ETag) if available and not forced full reload or date rollover
    if (cached != null && cached.etag != null && !forceFullReload && !isRollover) {
      headers['If-None-Match'] = cached.etag!;
    }

    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/dashboard-summary'),
        headers: headers,
      ).timeout(const Duration(seconds: 10));

      if (res.statusCode == 304 && cached != null) {
        // Data has not changed! Server returned 0-byte payload
        final refreshed = await updateSyncTimestamp(userId, syncedAt: DateTime.now());
        return HomeSyncResult(
          status: HomeSyncStatus.notModified,
          cacheData: refreshed ?? cached,
        );
      }

      if (res.statusCode == 200) {
        final dynamic decoded = json.decode(res.body);
        if (decoded is Map<String, dynamic>) {
          final serverEtag = res.headers['etag'];
          final updated = await saveDashboard(
            userId,
            decoded,
            etag: serverEtag,
            syncedAt: DateTime.now(),
          );
          return HomeSyncResult(
            status: HomeSyncStatus.success,
            cacheData: updated,
          );
        }
      }

      // If server returned non-200/304 but we have cache, fall back to cache
      if (cached != null) {
        return HomeSyncResult(
          status: HomeSyncStatus.offline,
          cacheData: cached,
          errorMessage: 'Server status ${res.statusCode}',
        );
      }

      return HomeSyncResult(
        status: HomeSyncStatus.error,
        errorMessage: 'Server error: ${res.statusCode}',
      );
    } catch (e) {
      // Offline or network error: retain cached data
      if (cached != null) {
        return HomeSyncResult(
          status: HomeSyncStatus.offline,
          cacheData: cached,
          errorMessage: e.toString(),
        );
      }
      return HomeSyncResult(
        status: HomeSyncStatus.error,
        errorMessage: 'Network error: $e',
      );
    }
  }
}

