import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import '../../utils/user_utils.dart';
import '../../services/reports_cache_service.dart';
import '../../utils/file_download_helper.dart';

Color parseHexColor(String? hexString) {
  if (hexString == null || hexString.isEmpty) return const Color(0xFF0B3C7A);
  try {
    final hex = hexString.replaceAll('#', '');
    return Color(int.parse('FF$hex', radix: 16));
  } catch (_) {
    return const Color(0xFF0B3C7A);
  }
}

class ReportsScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  const ReportsScreen({super.key, required this.user});

  @override
  State<ReportsScreen> createState() => _ReportsScreenState();
}

class _ReportsScreenState extends State<ReportsScreen> with WidgetsBindingObserver {
  String _token = '';
  bool _isDeveloper = false;
  String get _userId => resolveCurrentUserId(user: widget.user);

  // 1. Report Type Switcher: count | duration | holistic | complete_log
  String _reportType = 'count';
  Map<String, dynamic>? _countAnalytics;
  bool _isLoadingCount = false;
  Map<String, dynamic>? _cycleAnalytics; // Duration Analytics
  bool _isLoadingCycle = false;
  int? _selectedCycleGateId;
  Map<String, dynamic>? _holisticAnalytics;
  bool _isLoadingHolistic = false;

  // 1.5. Developer Gate & Device Mapping Registry
  Map<String, dynamic>? _deviceMappingData;
  bool _isLoadingDeviceMapping = false;
  final TextEditingController _mappingSearchCtrl = TextEditingController();
  String _mappingSearchQuery = '';
  String _mappingGateFilterType = 'all'; // 'all' | 'assigned' | 'unassigned'

  // 1.6 Attendance Muster & Exception Reports
  Map<String, dynamic>? _attendanceData;
  bool _isLoadingAttendance = false;
  Map<String, dynamic>? _attendanceExceptionsData;
  bool _isLoadingAttendanceExceptions = false;
  final TextEditingController _attendanceSearchCtrl = TextEditingController();
  String _attendanceSearchQuery = '';
  String _attendanceStatusFilter = 'ALL'; // 'ALL' | 'COMPLETED' | 'ON_DUTY' | 'LATE'

  // 2. Clusters & Hierarchy Selection
  List<dynamic> _clusters = [];
  bool _isLoadingClusters = true;
  final Set<int> _selectedClusterIds = {};
  final Set<int> _selectedGateIds = {};

  // 3. Date Range (Default: Last 7 Days)
  late DateTimeRange _dateRange;
  String _activePreset = '7days';

  // 4. Operational Records, Caching & Sync State
  List<dynamic> _records = [];
  Map<String, dynamic> _metrics = {
    'totalOperations': 0,
    'totalDurationFormatted': '0s',
    'avgDurationFormatted': '0s',
    'extendedDelaysCount': 0,
    'currentlyOpenCount': 0,
    'reportingGatesCount': 0,
  };
  ReportsCursor? _cursor;
  String? _cachedEtag;
  bool _isLoadingRecords = true;
  String _syncStatus = 'synced'; // 'synced' | 'updating' | 'outdated'
  bool _isRevalidating = false;
  bool _isSyncing = false;
  bool _isScopeVerified = false;
  Timer? _pollingTimer;
  DateTime? _lastSyncTime;
  AppLifecycleState _appLifecycleState = AppLifecycleState.resumed;

  // 5. Filters & Sorting
  String _filterStatus = 'ALL';
  String _filterShift = 'ALL';
  final String _sortBy = 'openedAt';
  String _sortOrder = 'desc';
  final TextEditingController _searchCtrl = TextEditingController();
  String _searchQuery = '';

  // 6. Generate Report Export State
  bool _isExporting = false;

  final List<Map<String, String>> _reportColumns = [
    {'key': 'lcNumber', 'label': 'LC Number'},
    {'key': 'masterUnit', 'label': 'Master Unit'},
    {'key': 'locationName', 'label': 'Location Name'},
    {'key': 'zone', 'label': 'Zone'},
    {'key': 'division', 'label': 'Division'},
    {'key': 'openedDate', 'label': 'Date'},
    {'key': 'openedTime', 'label': 'Opened Time (IST)'},
    {'key': 'closedTime', 'label': 'Closed Time (IST)'},
    {'key': 'durationFormatted', 'label': 'Duration'},
    {'key': 'status', 'label': 'Status'},
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final role = widget.user['role'];
    final roleStr = (role is Map ? (role['name'] ?? '') : (role ?? '')).toString().toLowerCase();
    _isDeveloper = roleStr == 'developer' ||
        widget.user['roleId'] == 1 ||
        widget.user['id'] == 1;
    if (!_isDeveloper && _reportType == 'device_mapping') {
      _reportType = 'count';
    }
    final nowIst = DateTime.now().toUtc().add(const Duration(hours: 5, minutes: 30));
    final todayIstCalendar = DateTime(nowIst.year, nowIst.month, nowIst.day);
    _dateRange = DateTimeRange(
      start: todayIstCalendar.subtract(const Duration(days: 7)),
      end: todayIstCalendar,
    );
    _loadTokenAndFetch();
    _startPollingTimer();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pollingTimer?.cancel();
    _searchCtrl.dispose();
    _mappingSearchCtrl.dispose();
    _attendanceSearchCtrl.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _appLifecycleState = state;
    if (state == AppLifecycleState.resumed) {
      if (_shouldPoll()) {
        final lastSync = _lastSyncTime;
        if (lastSync == null || DateTime.now().difference(lastSync).inSeconds >= 45) {
          _syncIncrementalChanges();
        }
      }
    }
  }

  ReportFilterParams get _currentFilterParams => ReportFilterParams(
        scopeGroupIds: _selectedClusterIds.toList(),
        gateIds: _selectedGateIds.toList(),
        startDate: _formatDate(_dateRange.start),
        endDate: _formatDate(_dateRange.end),
        status: _filterStatus,
        shift: _filterShift,
        search: _searchQuery,
        sortBy: _sortBy,
        sortOrder: _sortOrder,
      );

  void _startPollingTimer() {
    _pollingTimer?.cancel();
    _pollingTimer = Timer.periodic(const Duration(seconds: 45), (_) {
      if (_shouldPoll()) {
        _syncIncrementalChanges();
      }
    });
  }

  bool _shouldPoll() {
    if (!mounted) return false;
    if (_reportType != 'complete_log') return false;
    if (_appLifecycleState != AppLifecycleState.resumed) return false;
    if (_isSyncing || _isRevalidating) return false;
    if (_selectedGateIds.isEmpty) return false;
    return true;
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $_token',
      };

  Future<void> _loadTokenAndFetch() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString('token') ?? prefs.getString('auth_token') ?? '';
    await _fetchClusters();
  }

  String _formatDate(DateTime d) {
    final y = d.year.toString();
    final m = d.month.toString().padLeft(2, '0');
    final day = d.day.toString().padLeft(2, '0');
    return '$y-$m-$day';
  }

  void _invalidateCachedTabSnapshots() {
    _countAnalytics = null;
    _cycleAnalytics = null;
    _holisticAnalytics = null;
    _records = [];
    _cursor = null;
    _metrics = {
      'totalOperations': 0,
      'totalDurationFormatted': '0s',
      'avgDurationFormatted': '0s',
      'extendedDelaysCount': 0,
      'currentlyOpenCount': 0,
      'reportingGatesCount': 0,
    };
  }

  void _applyDatePreset(String preset) {
    setState(() {
      _activePreset = preset;
      final now = DateTime.now();
      if (preset == 'today') {
        _dateRange = DateTimeRange(start: now, end: now);
      } else if (preset == 'yesterday') {
        final y = now.subtract(const Duration(days: 1));
        _dateRange = DateTimeRange(start: y, end: y);
      } else if (preset == '7days') {
        _dateRange = DateTimeRange(start: now.subtract(const Duration(days: 7)), end: now);
      } else if (preset == '30days') {
        _dateRange = DateTimeRange(start: now.subtract(const Duration(days: 30)), end: now);
      } else if (preset == 'month') {
        _dateRange = DateTimeRange(start: DateTime(now.year, now.month, 1), end: now);
      }
      _invalidateCachedTabSnapshots();
    });
    _triggerReportFetch();
  }

  Future<void> _triggerReportFetch({bool forceReload = false}) async {
    if (_reportType == 'count') {
      await _fetchCountAnalytics();
    } else if (_reportType == 'duration' || _reportType == 'cycle') {
      await _fetchCycleAnalytics();
    } else if (_reportType == 'holistic') {
      await _fetchHolisticAnalytics();
    } else if (_reportType == 'attendance') {
      await _fetchAttendanceData(forceReload: forceReload);
    } else if (_reportType == 'attendance_exception') {
      await _fetchAttendanceExceptions(forceReload: forceReload);
    } else if (_reportType == 'device_mapping') {
      if (_isDeveloper) {
        await _fetchDeviceMapping(forceReload: forceReload);
      } else {
        setState(() => _reportType = 'count');
        await _fetchCountAnalytics();
      }
    } else {
      await _fetchRecords(forceReload: forceReload);
    }
  }

  // Fetch Developer Device & IoT Mapping Registry
  Future<void> _fetchDeviceMapping({bool forceReload = false}) async {
    if (!mounted || !_isDeveloper) return;
    setState(() => _isLoadingDeviceMapping = true);
    try {
      final uri = Uri.parse('$baseUrl/reports/device-mapping');
      final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && mounted) {
        setState(() {
          _deviceMappingData = json.decode(res.body);
        });
      } else if (res.statusCode == 403 && mounted) {
        AppFeedback.showError(context, 'Device Mapping is restricted to Developer role.');
      }
    } catch (e) {
      debugPrint('[ReportsScreen] Device mapping fetch error: $e');
    } finally {
      if (mounted) setState(() => _isLoadingDeviceMapping = false);
    }
  }


  // Fetch Count Report Analytics
  Future<void> _fetchCountAnalytics() async {
    if (!mounted) return;
    setState(() => _isLoadingCount = true);
    try {
      final queryParams = <String, String>{
        'startDate': _formatDate(_dateRange.start),
        'endDate': _formatDate(_dateRange.end),
      };
      if (_selectedGateIds.isNotEmpty) {
        queryParams['gateIds'] = _selectedGateIds.join(',');
      } else if (_isDeveloper) {
        queryParams['gateIds'] = 'all';
      }
      final uri = Uri.parse('$baseUrl/reports/count').replace(queryParameters: queryParams);
      final res = await http.get(uri, headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $_token',
      }).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && mounted) {
        setState(() {
          _countAnalytics = json.decode(res.body);
        });
      }
    } catch (e) {
      debugPrint('[ReportsScreen] Count analytics error: $e');
    } finally {
      if (mounted) setState(() => _isLoadingCount = false);
    }
  }

  // Fetch Holistic Report Analytics
  Future<void> _fetchHolisticAnalytics() async {
    if (!mounted) return;
    setState(() => _isLoadingHolistic = true);
    try {
      final queryParams = <String, String>{
        'startDate': _formatDate(_dateRange.start),
        'endDate': _formatDate(_dateRange.end),
      };
      if (_selectedGateIds.isNotEmpty) {
        queryParams['gateIds'] = _selectedGateIds.join(',');
      } else if (_isDeveloper) {
        queryParams['gateIds'] = 'all';
      }
      final uri = Uri.parse('$baseUrl/reports/holistic').replace(queryParameters: queryParams);
      final res = await http.get(uri, headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $_token',
      }).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && mounted) {
        setState(() {
          _holisticAnalytics = json.decode(res.body);
        });
      }
    } catch (e) {
      debugPrint('[ReportsScreen] Holistic analytics error: $e');
    } finally {
      if (mounted) setState(() => _isLoadingHolistic = false);
    }
  }

  // Fetch Cycle Analytics
  Future<void> _fetchCycleAnalytics() async {
    if (!mounted) return;
    setState(() => _isLoadingCycle = true);

    try {
      final queryParams = <String, String>{
        'startDate': _formatDate(_dateRange.start),
        'endDate': _formatDate(_dateRange.end),
      };

      if (_selectedClusterIds.isNotEmpty) {
        queryParams['scopeGroupIds'] = _selectedClusterIds.join(',');
      } else if (_isDeveloper) {
        queryParams['scopeGroupIds'] = 'all';
      }

      if (_selectedGateIds.isNotEmpty) {
        queryParams['gateIds'] = _selectedGateIds.join(',');
      } else if (_isDeveloper) {
        queryParams['gateIds'] = 'all';
      }

      final uri = Uri.parse('$baseUrl/reports/cycle-analytics').replace(queryParameters: queryParams);
      final res = await http.get(uri, headers: _headers);

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _cycleAnalytics = data as Map<String, dynamic>;
            _isLoadingCycle = false;
          });
        }
      } else {
        if (mounted) setState(() => _isLoadingCycle = false);
      }
    } catch (e) {
      debugPrint('[ReportsScreen] Cycle analytics fetch error: $e');
      if (mounted) setState(() => _isLoadingCycle = false);
    }
  }

  // 1. Fetch Clusters Tree with Online Authorization Scope Verification
  Future<void> _fetchClusters({bool forceReload = false}) async {
    final cachedHier = await ReportsCacheService.instance.getCachedHierarchy(_userId);

    try {
      final headers = Map<String, String>.from(_headers);
      if (cachedHier?.etag != null && !forceReload) {
        headers['If-None-Match'] = cachedHier!.etag!;
      }

      final res = await http
          .get(Uri.parse('$baseUrl/reports/clusters'), headers: headers)
          .timeout(const Duration(seconds: 4));

      if (res.statusCode == 304 && cachedHier != null) {
        await ReportsCacheService.instance.touchHierarchyVerified(_userId);
        if (mounted) {
          setState(() {
            _clusters = cachedHier.clusters;
            _isLoadingClusters = false;
            _isScopeVerified = true;
            if (_selectedClusterIds.isEmpty) {
              _selectedClusterIds.clear();
              _selectedGateIds.clear();
              for (final c in cachedHier.clusters) {
                if (c['id'] != null) _selectedClusterIds.add(c['id'] as int);
                final gates = (c['gates'] as List?) ?? [];
                for (final g in gates) {
                  if (g['id'] != null) _selectedGateIds.add(g['id'] as int);
                }
              }
            }
          });
          _triggerReportFetch();
        }
        return;
      }

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final list = (data['clusters'] as List?) ?? [];
        final etag = res.headers['etag'] ?? data['directoryRevisionToken'] as String?;

        if (cachedHier != null) {
          final prevGateIds = <int>{};
          for (final c in cachedHier.clusters) {
            for (final g in (c['gates'] as List? ?? [])) {
              if (g['id'] != null) prevGateIds.add(g['id'] as int);
            }
          }
          final newGateIds = <int>{};
          for (final c in list) {
            for (final g in (c['gates'] as List? ?? [])) {
              if (g['id'] != null) newGateIds.add(g['id'] as int);
            }
          }
          final hasRevocations = prevGateIds.any((id) => !newGateIds.contains(id));
          if (hasRevocations || etag != cachedHier.etag) {
            debugPrint('[ReportsScreen] Scope changed or gate access revoked. Purging cached reports for user.');
            await ReportsCacheService.instance.clearUserCache(_userId);
          }
        }

        await ReportsCacheService.instance.saveHierarchy(_userId, list, data['isDeveloper'] == true, etag);

        if (mounted) {
          setState(() {
            _clusters = list;
            _isLoadingClusters = false;
            _isScopeVerified = true;
            final allClusterIds = <int>[];
            final allGateIds = <int>[];
            for (final c in list) {
              if (c['id'] != null) allClusterIds.add(c['id'] as int);
              final gates = (c['gates'] as List?) ?? [];
              for (final g in gates) {
                if (g['id'] != null) allGateIds.add(g['id'] as int);
              }
            }

            if (_selectedClusterIds.isEmpty) {
              _selectedClusterIds.clear();
              _selectedClusterIds.addAll(allClusterIds);
              _selectedGateIds.clear();
              _selectedGateIds.addAll(allGateIds);
            } else {
              _selectedClusterIds.retainWhere((id) => allClusterIds.contains(id));
              _selectedGateIds.retainWhere((id) => allGateIds.contains(id));
              if (_selectedGateIds.isEmpty) {
                _selectedClusterIds.addAll(allClusterIds);
                _selectedGateIds.addAll(allGateIds);
              }
            }
            _invalidateCachedTabSnapshots();
          });
          _triggerReportFetch(forceReload: true);
        }
        return;
      } else if (res.statusCode == 403 && mounted) {
        AppFeedback.showError(context, 'No LC gates are assigned to your user account.');
      }
    } catch (e) {
      debugPrint('[ReportsScreen] Scope verification / hierarchy error (offline fallback): $e');
      if (cachedHier != null && mounted) {
        setState(() {
          _clusters = cachedHier.clusters;
          _isLoadingClusters = false;
          _isScopeVerified = true;
          _syncStatus = 'outdated';
          if (_selectedClusterIds.isEmpty) {
            _selectedClusterIds.clear();
            _selectedGateIds.clear();
            for (final c in cachedHier.clusters) {
              if (c['id'] != null) _selectedClusterIds.add(c['id'] as int);
              final gates = (c['gates'] as List?) ?? [];
              for (final g in gates) {
                if (g['id'] != null) _selectedGateIds.add(g['id'] as int);
              }
            }
          }
        });
        if (_reportType == 'count') {
          _fetchCountAnalytics();
        } else if (_reportType == 'duration' || _reportType == 'cycle') {
          _fetchCycleAnalytics();
        } else if (_reportType == 'holistic') {
          _fetchHolisticAnalytics();
        } else if (_reportType == 'attendance') {
          _fetchAttendanceData();
        } else if (_reportType == 'attendance_exception') {
          _fetchAttendanceExceptions();
        } else {
          _fetchRecords();
        }
      }
    } finally {
      if (mounted) setState(() => _isLoadingClusters = false);
    }
  }

  // 2. Fetch Operational Records with Two-Level SWR & HTTP 304 Handling
  Future<void> _fetchRecords({bool forceReload = false}) async {
    if (_selectedGateIds.isEmpty) {
      if (mounted) {
        setState(() {
          _records = [];
          _isLoadingRecords = false;
          _syncStatus = 'synced';
        });
      }
      return;
    }

    final params = _currentFilterParams;

    if (!_isScopeVerified) {
      if (mounted) setState(() => _isLoadingRecords = true);
      return;
    }

    final cached = await ReportsCacheService.instance.getCachedReport(_userId, params);
    if (cached != null) {
      if (mounted) {
        setState(() {
          _records = cached.records.map((r) => r.toJson()).toList();
          _metrics = cached.authoritativeMetrics?.toJson() ?? _metrics;
          _cursor = cached.cursor;
          _cachedEtag = cached.etag;
          _isLoadingRecords = false;
        });
      }

      if (cached.isFresh && !forceReload) {
        if (mounted) setState(() => _syncStatus = 'synced');
        return;
      }
    } else {
      if (mounted) setState(() => _isLoadingRecords = true);
    }

    _isRevalidating = true;
    if (mounted && cached != null) setState(() => _syncStatus = 'updating');

    try {
      final queryParams = <String, String>{
        'startDate': _formatDate(_dateRange.start),
        'endDate': _formatDate(_dateRange.end),
        'sortBy': _sortBy,
        'sortOrder': _sortOrder,
      };

      if (_selectedClusterIds.isNotEmpty) {
        queryParams['scopeGroupIds'] = _selectedClusterIds.join(',');
      } else if (_isDeveloper) {
        queryParams['scopeGroupIds'] = 'all';
      }

      if (_selectedGateIds.isNotEmpty) {
        queryParams['gateIds'] = _selectedGateIds.join(',');
      } else if (_isDeveloper) {
        queryParams['gateIds'] = 'all';
      }

      if (_filterStatus != 'ALL') queryParams['status'] = _filterStatus;
      if (_filterShift != 'ALL') queryParams['shift'] = _filterShift;
      if (_searchQuery.trim().isNotEmpty) queryParams['search'] = _searchQuery.trim();

      final uri = Uri.parse('$baseUrl/reports/records').replace(queryParameters: queryParams);
      final headers = Map<String, String>.from(_headers);
      final etagToSend = cached?.etag ?? _cachedEtag;
      if (etagToSend != null && !forceReload) {
        headers['If-None-Match'] = etagToSend;
      }

      final res = await http.get(uri, headers: headers);

      if (res.statusCode == 304 && cached != null) {
        await ReportsCacheService.instance.touchVerified(_userId, params, newEtag: res.headers['etag']);
        _lastSyncTime = DateTime.now();
        if (mounted) setState(() => _syncStatus = 'synced');
        return;
      }

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final rawRecords = (data['records'] as List?) ?? [];
        final parsedRecords = rawRecords.map((r) => OperationalRecord.fromJson(r as Map<String, dynamic>)).toList();
        final rawMetrics = data['metrics'] != null ? AuthoritativeReportMetrics.fromJson(data['metrics'] as Map<String, dynamic>) : null;
        final rawCursor = data['cursor'] != null
            ? ReportsCursor.fromJson(data['cursor'] as Map<String, dynamic>)
            : ReportsCursor(eventCursorTime: '', eventCursorId: 0, tombstoneCursorId: '0', gateRevisions: {}, serverTime: '');
        final etag = res.headers['etag'];

        await ReportsCacheService.instance.saveReport(
          _userId,
          params,
          records: parsedRecords,
          metrics: rawMetrics,
          etag: etag,
          cursor: rawCursor,
        );

        _lastSyncTime = DateTime.now();
        if (mounted) {
          setState(() {
            _records = rawRecords;
            _metrics = rawMetrics?.toJson() ?? _metrics;
            _cursor = rawCursor;
            _cachedEtag = etag;
            _syncStatus = 'synced';
          });
        }
      } else {
        if (mounted && cached != null) setState(() => _syncStatus = 'outdated');
      }
    } catch (e) {
      debugPrint('[ReportsScreen] Network fetch error: $e');
      if (mounted) setState(() => _syncStatus = 'outdated');
    } finally {
      _isRevalidating = false;
      if (mounted) setState(() => _isLoadingRecords = false);
    }
  }

  // 2.5. Transactionally Serialized 45-Second Incremental Polling Engine
  Future<void> _syncIncrementalChanges() async {
    if (_isSyncing || _isRevalidating) return;
    if (_cursor == null || _cursor!.gateRevisions.isEmpty) return;

    _isSyncing = true;
    if (mounted) setState(() => _syncStatus = 'updating');

    try {
      final params = _currentFilterParams;
      var currentGateRevisions = Map<String, String>.from(_cursor!.gateRevisions);
      var keepDraining = true;
      var drainLoops = 0;
      const maxDrainLoops = 20;

      while (keepDraining && drainLoops < maxDrainLoops) {
        drainLoops++;
        final queryParams = <String, String>{
          'startDate': _formatDate(_dateRange.start),
          'endDate': _formatDate(_dateRange.end),
          'gateRevisions': json.encode(currentGateRevisions),
        };

        if (_selectedClusterIds.isNotEmpty) {
          queryParams['scopeGroupIds'] = _selectedClusterIds.join(',');
        } else if (_isDeveloper) {
          queryParams['scopeGroupIds'] = 'all';
        }

        if (_selectedGateIds.isNotEmpty) {
          queryParams['gateIds'] = _selectedGateIds.join(',');
        } else if (_isDeveloper) {
          queryParams['gateIds'] = 'all';
        }

        if (_filterStatus != 'ALL') queryParams['status'] = _filterStatus;
        if (_filterShift != 'ALL') queryParams['shift'] = _filterShift;
        if (_searchQuery.trim().isNotEmpty) queryParams['search'] = _searchQuery.trim();

        final uri = Uri.parse('$baseUrl/reports/records/changes').replace(queryParameters: queryParams);
        final res = await http.get(uri, headers: _headers);

        if (res.statusCode != 200) {
          if (mounted) setState(() => _syncStatus = 'outdated');
          break;
        }

        final data = json.decode(res.body);
        final payload = IncrementalChangesPayload.fromJson(data);

        if (payload.requiresFullSync) {
          debugPrint('[ReportsScreen] Server requested full re-sync: ${payload.resyncReason}');
          keepDraining = false;
          if (payload.resyncReason == 'GATE_REVOKED') {
            await ReportsCacheService.instance.clearUserCache(_userId);
            await _fetchClusters(forceReload: true);
          }
          await _fetchRecords(forceReload: true);
          break;
        }

        final updated = await ReportsCacheService.instance.updateIncrementalChanges(_userId, params, payload);
        if (updated != null) {
          if (mounted) {
            setState(() {
              _records = updated.records.map((r) => r.toJson()).toList();
              _metrics = updated.authoritativeMetrics?.toJson() ?? _metrics;
              _cursor = updated.cursor;
              _cachedEtag = updated.etag;
              _syncStatus = 'synced';
            });
          }
        }

        keepDraining = payload.hasMoreEvents;
        if (payload.gateRevisions != null) {
          currentGateRevisions = Map<String, String>.from(payload.gateRevisions!);
        }
      }

      _lastSyncTime = DateTime.now();
      if (mounted) setState(() => _syncStatus = 'synced');
    } catch (e) {
      debugPrint('[ReportsScreen] Incremental sync error: $e');
      if (mounted) setState(() => _syncStatus = 'outdated');
    } finally {
      _isSyncing = false;
    }
  }

  // 3. Scope Groups & Gates Selection Modal Sheet
  void _showHierarchyTreeSheet() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            return Material(
              color: Colors.white,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
              clipBehavior: Clip.antiAlias,
              child: SizedBox(
                height: MediaQuery.of(context).size.height * 0.78,
                child: Column(
                  children: [
                    Container(
                      margin: const EdgeInsets.only(top: 10, bottom: 6),
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(color: Colors.grey.shade300, borderRadius: BorderRadius.circular(2)),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Select LC Gates', style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: AppColors.primary)),
                          Row(
                            children: [
                              TextButton(
                                onPressed: () {
                                  setSheetState(() {
                                    for (final c in _clusters) {
                                      if (c['id'] != null) _selectedClusterIds.add(c['id'] as int);
                                      for (final g in (c['gates'] as List? ?? [])) {
                                        if (g['id'] != null) _selectedGateIds.add(g['id'] as int);
                                      }
                                    }
                                  });
                                },
                                child: const Text('All', style: TextStyle(fontWeight: FontWeight.bold)),
                              ),
                              const Text('|', style: TextStyle(color: Colors.grey)),
                              TextButton(
                                onPressed: () {
                                  setSheetState(() {
                                    _selectedClusterIds.clear();
                                    _selectedGateIds.clear();
                                  });
                                },
                                child: const Text('Clear', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.grey)),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    const Divider(height: 1),
                    Expanded(
                      child: ListView.builder(
                        itemCount: _clusters.length,
                        itemBuilder: (ctx, idx) {
                          final cluster = _clusters[idx];
                          final cId = cluster['id'] as int;
                          final gates = (cluster['gates'] as List?) ?? [];
                          final cColor = parseHexColor(cluster['color']);
                          final isClusterChecked = _selectedClusterIds.contains(cId);

                          return ExpansionTile(
                            initiallyExpanded: true,
                            leading: Checkbox(
                              value: isClusterChecked,
                              activeColor: AppColors.primary,
                              onChanged: (val) {
                                setSheetState(() {
                                  if (val == true) {
                                    _selectedClusterIds.add(cId);
                                    for (final g in gates) {
                                      if (g['id'] != null) _selectedGateIds.add(g['id'] as int);
                                    }
                                  } else {
                                    _selectedClusterIds.remove(cId);
                                    for (final g in gates) {
                                      if (g['id'] != null) _selectedGateIds.remove(g['id'] as int);
                                    }
                                  }
                                });
                              },
                            ),
                            title: Row(
                              children: [
                                Container(
                                  width: 10,
                                  height: 10,
                                  decoration: BoxDecoration(color: cColor, shape: BoxShape.circle),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    cluster['name'] == 'All Gates' || cluster['name'] == 'Assigned LC Gates' || cluster['name'] == 'Cluster' ? 'Assigned LC Gates' : (cluster['name'] ?? 'Assigned LC Gates'),
                                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                  ),
                                ),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                                  decoration: BoxDecoration(color: Colors.grey.shade100, borderRadius: BorderRadius.circular(10)),
                                  child: Text('${gates.length} gates', style: const TextStyle(fontSize: 11, color: Colors.grey)),
                                ),
                              ],
                            ),
                            children: gates.map((gate) {
                              final gId = gate['id'] as int;
                              final isGateChecked = _selectedGateIds.contains(gId);
                              return CheckboxListTile(
                                dense: true,
                                contentPadding: const EdgeInsets.only(left: 48, right: 16),
                                value: isGateChecked,
                                activeColor: AppColors.primary,
                                title: Text(gate['lcNumber'] ?? 'LC', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                                subtitle: Text(gate['locationName'] ?? '', style: const TextStyle(fontSize: 11.5, color: Colors.grey)),
                                onChanged: (val) {
                                  setSheetState(() {
                                    if (val == true) {
                                      _selectedGateIds.add(gId);
                                      _selectedClusterIds.add(cId);
                                    } else {
                                      _selectedGateIds.remove(gId);
                                      final anyLeft = gates.any((g) => _selectedGateIds.contains(g['id']));
                                      if (!anyLeft) _selectedClusterIds.remove(cId);
                                    }
                                  });
                                },
                              );
                            }).toList(),
                          );
                        },
                      ),
                    ),
                    SafeArea(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: SizedBox(
                          width: double.infinity,
                          height: 48,
                          child: ElevatedButton(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: AppColors.primary,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                            onPressed: () {
                              Navigator.pop(ctx);
                              setState(() {
                                _invalidateCachedTabSnapshots();
                              });
                              _triggerReportFetch();
                            },
                            child: Text('Apply Selection (${_selectedGateIds.length} Gates)', style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  // 3.5. Staged Progress Report Export Dialog
  void _startExportWithProgress({
    required BuildContext parentCtx,
    required String selectedReportType,
    required String selectedFormat,
    required Set<String> selectedCols,
  }) async {
    Navigator.pop(parentCtx);
    if (selectedReportType == 'device_mapping' && !_isDeveloper) {
      AppFeedback.showError(context, 'Device Mapping export is restricted to Developer role.');
      return;
    }
    setState(() => _isExporting = true);

    double progress = 0.05;
    String stage = 'Initiating export request...';
    Timer? progressTimer;
    StateSetter? updateDialog;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (dCtx) => StatefulBuilder(
        builder: (dCtx, setDlgState) {
          updateDialog = setDlgState;
          return Dialog(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 54,
                    height: 54,
                    decoration: BoxDecoration(
                      color: (selectedFormat == 'pdf' ? const Color(0xFFE11D48) : const Color(0xFF107C41)).withValues(alpha: 0.1),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      selectedFormat == 'pdf' ? Icons.picture_as_pdf_rounded : Icons.table_view_rounded,
                      color: selectedFormat == 'pdf' ? const Color(0xFFE11D48) : const Color(0xFF107C41),
                      size: 28,
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    'Generating ${selectedFormat.toUpperCase()} Report',
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFF0F172A)),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    selectedReportType == 'device_mapping'
                        ? 'Compiling physical controller & AWS IoT Thing mapping...'
                        : (selectedReportType == 'cycle' ? 'Compiling operating cycle analytics...' : 'Compiling operational logs & metrics...'),
                    style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600),
                  ),
                  const SizedBox(height: 18),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: LinearProgressIndicator(
                      value: progress,
                      minHeight: 8,
                      backgroundColor: Colors.grey.shade200,
                      valueColor: AlwaysStoppedAnimation<Color>(
                        selectedFormat == 'pdf' ? const Color(0xFFE11D48) : const Color(0xFF107C41),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          stage,
                          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: Color(0xFF475569)),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      Text(
                        '${(progress * 100).toInt()}%',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                          color: selectedFormat == 'pdf' ? const Color(0xFFE11D48) : const Color(0xFF107C41),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );

    progressTimer = Timer.periodic(const Duration(milliseconds: 300), (_) {
      if (updateDialog != null) {
        updateDialog!(() {
          if (progress < 0.40) {
            progress += 0.10;
            stage = 'Calculating metrics & layouts...';
          } else if (progress < 0.75) {
            progress += 0.07;
            stage = selectedFormat == 'pdf' ? 'Rendering PDF document pages...' : 'Building Excel spreadsheet...';
          } else if (progress < 0.92) {
            progress += 0.03;
            stage = 'Saving file to device...';
          }
        });
      }
    });

    try {
      final queryParams = <String, String>{
        'startDate': _formatDate(_dateRange.start),
        'endDate': _formatDate(_dateRange.end),
        'format': selectedFormat,
        'reportType': selectedReportType,
        'columns': selectedCols.join(','),
        'sortBy': _sortBy,
        'sortOrder': _sortOrder,
      };
      if (_selectedClusterIds.isNotEmpty) queryParams['scopeGroupIds'] = _selectedClusterIds.join(',');
      if (_selectedGateIds.isNotEmpty) {
        queryParams['gateIds'] = _selectedGateIds.join(',');
      } else if (_isDeveloper) {
        queryParams['gateIds'] = 'all';
      }
      if (_filterStatus != 'ALL') queryParams['status'] = _filterStatus;
      if (_filterShift != 'ALL') queryParams['shift'] = _filterShift;
      if (_searchQuery.trim().isNotEmpty) queryParams['search'] = _searchQuery.trim();

      final uri = Uri.parse('$baseUrl/reports/export').replace(queryParameters: queryParams);
      final res = await http.get(uri, headers: _headers);

      progressTimer.cancel();

      if (res.statusCode == 200) {
        if (updateDialog != null) {
          updateDialog!(() {
            progress = 1.0;
            stage = 'Report ready! Opening...';
          });
        }
        await Future.delayed(const Duration(milliseconds: 350));
        if (mounted && Navigator.canPop(context)) {
          Navigator.pop(context);
        }

        try {
          final ext = selectedFormat == 'pdf' ? 'pdf' : (selectedFormat == 'csv' ? 'csv' : 'xlsx');
          final mimeType = selectedFormat == 'pdf'
              ? 'application/pdf'
              : (selectedFormat == 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          final timestamp = DateTime.now().millisecondsSinceEpoch;
          final filename = selectedReportType == 'device_mapping'
              ? 'LC_Gate_Device_IoT_Mapping_$timestamp.$ext'
              : selectedReportType == 'count'
                  ? 'LC_Gate_Count_Report_$timestamp.$ext'
                  : selectedReportType == 'holistic'
                      ? 'LC_Gate_Holistic_Report_$timestamp.$ext'
                      : selectedReportType == 'cycle' || selectedReportType == 'duration'
                          ? 'LC_Gate_Duration_Report_$timestamp.$ext'
                          : 'LC_Gate_Complete_Log_$timestamp.$ext';

          await downloadFileUniversal(
            bytes: res.bodyBytes,
            filename: filename,
            mimeType: mimeType,
          );

          if (mounted) {
            AppFeedback.showSuccess(
              context,
              'Report exported successfully (${(res.bodyBytes.length / 1024).toStringAsFixed(1)} KB)!',
            );
          }
        } catch (fileErr) {
          if (mounted) {
            AppFeedback.showWarning(context, 'Report downloaded, but viewer error: $fileErr');
          }
        }
      } else {
        if (mounted && Navigator.canPop(context)) Navigator.pop(context);
        if (mounted) AppFeedback.showError(context, 'Export failed: HTTP ${res.statusCode}');
      }
    } catch (e) {
      progressTimer.cancel();
      if (mounted && Navigator.canPop(context)) Navigator.pop(context);
      if (mounted) AppFeedback.showError(context, 'Export error: $e');
    } finally {
      progressTimer.cancel();
      if (mounted) setState(() => _isExporting = false);
    }
  }

  // 4. Generate Report Modal (Excel & PDF)
  void _showGenerateModal() {
    String selectedReportType = _reportType;
    if (!_isDeveloper && selectedReportType == 'device_mapping') {
      selectedReportType = 'count';
    }
    String selectedFormat = 'xlsx';
    final Set<String> selectedCols = _reportColumns.map((c) => c['key']!).toSet();

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setModalState) {
            return Material(
              color: Colors.white,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
              clipBehavior: Clip.antiAlias,
              child: SizedBox(
                height: MediaQuery.of(context).size.height * 0.85,
                child: Column(
                  children: [
                    Container(
                      margin: const EdgeInsets.only(top: 10, bottom: 6),
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(color: Colors.grey.shade300, borderRadius: BorderRadius.circular(2)),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Generate Operational Report', style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: AppColors.primary)),
                          IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                        ],
                      ),
                    ),
                    const Divider(height: 1),
                    Expanded(
                      child: ListView(
                        padding: const EdgeInsets.all(16),
                        children: [
                          const Text('SELECT REPORT TYPE', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.grey)),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedReportType = 'count'),
                                  child: Container(
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: selectedReportType == 'count' ? const Color(0xFF2563EB).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: selectedReportType == 'count' ? const Color(0xFF2563EB) : Colors.grey.shade300,
                                        width: 2,
                                      ),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.format_list_numbered_rounded, color: Color(0xFF2563EB), size: 22),
                                        SizedBox(height: 4),
                                        Text('Count', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                        Text('Ops Rollup', style: TextStyle(fontSize: 10, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedReportType = 'duration'),
                                  child: Container(
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: (selectedReportType == 'duration' || selectedReportType == 'cycle') ? const Color(0xFF046A38).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: (selectedReportType == 'duration' || selectedReportType == 'cycle') ? const Color(0xFF046A38) : Colors.grey.shade300,
                                        width: 2,
                                      ),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.timer_outlined, color: Color(0xFF046A38), size: 22),
                                        SizedBox(height: 4),
                                        Text('Duration', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                        Text('Open/Close', style: TextStyle(fontSize: 10, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedReportType = 'holistic'),
                                  child: Container(
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: selectedReportType == 'holistic' ? const Color(0xFF7C3AED).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: selectedReportType == 'holistic' ? const Color(0xFF7C3AED) : Colors.grey.shade300,
                                        width: 2,
                                      ),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.account_tree_outlined, color: Color(0xFF7C3AED), size: 22),
                                        SizedBox(height: 4),
                                        Text('Holistic', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                        Text('Exec Tree', style: TextStyle(fontSize: 10, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedReportType = 'complete_log'),
                                  child: Container(
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: selectedReportType == 'complete_log' ? AppColors.primary.withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: selectedReportType == 'complete_log' ? AppColors.primary : Colors.grey.shade300,
                                        width: 2,
                                      ),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.table_rows_outlined, color: AppColors.primary, size: 22),
                                        SizedBox(height: 4),
                                        Text('Event Log', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                        Text('Raw Events', style: TextStyle(fontSize: 10, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedReportType = 'attendance'),
                                  child: Container(
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: selectedReportType == 'attendance' ? const Color(0xFF0284C7).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: selectedReportType == 'attendance' ? const Color(0xFF0284C7) : Colors.grey.shade300,
                                        width: 2,
                                      ),
                                    ),
                                    child: const Column(
                                      children: [
                                        Icon(Icons.badge_outlined, color: Color(0xFF0284C7), size: 22),
                                        SizedBox(height: 4),
                                        Text('Attendance', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                        Text('Muster Log', style: TextStyle(fontSize: 10, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedReportType = 'attendance_exception'),
                                  child: Container(
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: (selectedReportType == 'attendance_exception' || selectedReportType == 'exception') ? const Color(0xFFDC2626).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: (selectedReportType == 'attendance_exception' || selectedReportType == 'exception') ? const Color(0xFFDC2626) : Colors.grey.shade300,
                                        width: 2,
                                      ),
                                    ),
                                    child: const Column(
                                      children: [
                                        Icon(Icons.warning_amber_rounded, color: Color(0xFFDC2626), size: 22),
                                        SizedBox(height: 4),
                                        Text('Exceptions', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                        Text('Safety Audit', style: TextStyle(fontSize: 10, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          if (_isDeveloper) ...[
                            const SizedBox(height: 8),
                            InkWell(
                              onTap: () => setModalState(() => selectedReportType = 'device_mapping'),
                              child: Container(
                                padding: const EdgeInsets.all(10),
                                decoration: BoxDecoration(
                                  color: selectedReportType == 'device_mapping' ? const Color(0xFFD97706).withValues(alpha: 0.08) : Colors.white,
                                  borderRadius: BorderRadius.circular(10),
                                  border: Border.all(
                                    color: selectedReportType == 'device_mapping' ? const Color(0xFFD97706) : Colors.grey.shade300,
                                    width: 2,
                                  ),
                                ),
                                child: const Row(
                                  children: [
                                    Icon(Icons.developer_board, color: Color(0xFFD97706), size: 22),
                                    SizedBox(width: 10),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Text('Gate & Device Mapping (Developer Only)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5)),
                                          Text('Physical Master Unit · AWS IoT Thing · SIM ICCID cross-linkage', style: TextStyle(fontSize: 10.5, color: Colors.grey)),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                          const SizedBox(height: 16),

                          Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: Colors.grey.shade50,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: Colors.grey.shade200),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('Range: ${_formatDate(_dateRange.start)} to ${_formatDate(_dateRange.end)}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                                const SizedBox(height: 4),
                                Text('Selected: ${_selectedGateIds.length} LC Gate${_selectedGateIds.length == 1 ? "" : "s"}', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                                Text(
                                  selectedReportType == 'cycle' ? 'Scope: Analytical cycle audit & daily KPIs' : 'Events in range: ${_records.length}',
                                  style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 16),
                          const Text('SELECT DOCUMENT FORMAT', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.grey)),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedFormat = 'xlsx'),
                                  child: Container(
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: selectedFormat == 'xlsx' ? const Color(0xFF107C41).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(color: selectedFormat == 'xlsx' ? const Color(0xFF107C41) : Colors.grey.shade300, width: 2),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.table_view_rounded, color: Color(0xFF107C41), size: 24),
                                        SizedBox(height: 4),
                                        Text('Excel', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                        Text('.xlsx', style: TextStyle(fontSize: 10, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedFormat = 'pdf'),
                                  child: Container(
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: selectedFormat == 'pdf' ? const Color(0xFFE11D48).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(color: selectedFormat == 'pdf' ? const Color(0xFFE11D48) : Colors.grey.shade300, width: 2),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.picture_as_pdf_rounded, color: Color(0xFFE11D48), size: 24),
                                        SizedBox(height: 4),
                                        Text('PDF', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                        Text('.pdf', style: TextStyle(fontSize: 10, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedFormat = 'csv'),
                                  child: Container(
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: selectedFormat == 'csv' ? const Color(0xFF2563EB).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(color: selectedFormat == 'csv' ? const Color(0xFF2563EB) : Colors.grey.shade300, width: 2),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.file_present_rounded, color: Color(0xFF2563EB), size: 24),
                                        SizedBox(height: 4),
                                        Text('CSV', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                        Text('.csv', style: TextStyle(fontSize: 10, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 18),
                          if (selectedReportType == 'complete_log') ...[
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                const Text('SELECT COLUMNS', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.grey)),
                                Row(
                                  children: [
                                    TextButton(
                                      onPressed: () => setModalState(() => selectedCols.addAll(_reportColumns.map((c) => c['key']!))),
                                      child: const Text('All', style: TextStyle(fontSize: 11)),
                                    ),
                                    TextButton(
                                      onPressed: () => setModalState(() {
                                        selectedCols.clear();
                                        selectedCols.addAll(['lcNumber', 'locationName', 'openedDate', 'openedTime', 'durationFormatted', 'status']);
                                      }),
                                      child: const Text('Default', style: TextStyle(fontSize: 11)),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                            ..._reportColumns.map((col) {
                              final k = col['key']!;
                              final isChecked = selectedCols.contains(k);
                              return CheckboxListTile(
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                title: Text(col['label']!, style: const TextStyle(fontSize: 13)),
                                value: isChecked,
                                activeColor: AppColors.primary,
                                onChanged: (val) {
                                  setModalState(() {
                                    if (val == true) {
                                      selectedCols.add(k);
                                    } else if (selectedCols.length > 1) {
                                      selectedCols.remove(k);
                                    }
                                  });
                                },
                              );
                            }),
                          ] else ...[
                            Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: const Color(0xFF046A38).withValues(alpha: 0.06),
                                borderRadius: BorderRadius.circular(10),
                                border: Border.all(color: const Color(0xFF046A38).withValues(alpha: 0.2)),
                              ),
                              child: Row(
                                children: const [
                                  Icon(Icons.info_outline_rounded, color: Color(0xFF046A38), size: 20),
                                  SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      'Cycle Report includes daily operating cycle counts, average opening/closing durations, and total operational window metrics.',
                                      style: TextStyle(fontSize: 11.5, color: Color(0xFF046A38)),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    SafeArea(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: SizedBox(
                          width: double.infinity,
                          height: 48,
                          child: ElevatedButton.icon(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: selectedFormat == 'xlsx' ? const Color(0xFF107C41) : const Color(0xFFE11D48),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                            icon: _isExporting ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2)) : const Icon(Icons.download, color: Colors.white),
                            label: Text(_isExporting ? 'Generating...' : 'Download ${selectedFormat.toUpperCase()} Report', style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
                            onPressed: _isExporting
                                ? null
                                : () {
                                    _startExportWithProgress(
                                      parentCtx: ctx,
                                      selectedReportType: selectedReportType,
                                      selectedFormat: selectedFormat,
                                      selectedCols: selectedCols,
                                    );
                                  },
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.grey.shade50,
      appBar: AppBar(
        title: const Text('Operational Reports', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        backgroundColor: Colors.white,
        foregroundColor: AppColors.primary,
        elevation: 0.5,
        actions: [
          _buildSyncStatusBadge(),
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Force Refresh',
            onPressed: () => _triggerReportFetch(forceReload: true),
          ),
          IconButton(
            icon: const Icon(Icons.download, color: Color(0xFF10B981)),
            tooltip: 'Generate Report',
            onPressed: _showGenerateModal,
          ),
        ],
      ),
      body: _isLoadingClusters
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () => _triggerReportFetch(forceReload: true),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 28),
                children: [
                  // 1. Report Type Selector
                  _buildReportTypeSelector(),

                  if (_reportType != 'device_mapping') ...[
                    // 2. Scope Groups & Gates Tree Trigger Card
                    InkWell(
                      onTap: _showHierarchyTreeSheet,
                      child: Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: Colors.grey.shade200),
                        ),
                        child: Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.all(8),
                              decoration: BoxDecoration(color: AppColors.primary.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(8)),
                              child: const Icon(Icons.account_tree_outlined, color: AppColors.primary, size: 20),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text('Select Level Crossing Gates', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5)),
                                  Text('${_selectedGateIds.length} Gate(s) Selected for Analytics', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                                ],
                              ),
                            ),
                            const Icon(Icons.chevron_right, color: Colors.grey),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),

                    // 3. Date Range Picker Card & Presets
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: Colors.grey.shade200),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              const Text('DATE RANGE', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.grey)),
                              InkWell(
                                onTap: () async {
                                  final picked = await showDateRangePicker(
                                    context: context,
                                    firstDate: DateTime(2025),
                                    lastDate: DateTime.now().add(const Duration(days: 1)),
                                    initialDateRange: _dateRange,
                                  );
                                  if (picked != null) {
                                    setState(() {
                                      _dateRange = picked;
                                      _activePreset = 'custom';
                                      _invalidateCachedTabSnapshots();
                                    });
                                    _triggerReportFetch();
                                  }
                                },
                                child: const Row(
                                  children: [
                                    Icon(Icons.calendar_month, size: 14, color: AppColors.primary),
                                    SizedBox(width: 4),
                                    Text('Pick Range', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary)),
                                  ],
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          SingleChildScrollView(
                            scrollDirection: Axis.horizontal,
                            child: Row(
                              children: [
                                _buildPresetChip('7days', 'Last 7 Days'),
                                _buildPresetChip('today', 'Today'),
                                _buildPresetChip('yesterday', 'Yesterday'),
                                _buildPresetChip('30days', 'Last 30 Days'),
                                _buildPresetChip('month', 'This Month'),
                              ],
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            '${_formatDate(_dateRange.start)}  ➔  ${_formatDate(_dateRange.end)}',
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: AppColors.primary),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 10),
                  ],

                  // 4. Report Body: Complete Log vs Cycle Report
                  if (_reportType == 'complete_log') ...[
                    _buildKpiSection(),
                    const SizedBox(height: 10),

                    // Search Input
                    Container(
                      height: 42,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: Colors.grey.shade200),
                      ),
                      child: TextField(
                        controller: _searchCtrl,
                        decoration: const InputDecoration(
                          hintText: 'Search LC#, location...',
                          hintStyle: TextStyle(fontSize: 12.5),
                          prefixIcon: Icon(Icons.search, size: 18),
                          border: InputBorder.none,
                          contentPadding: EdgeInsets.symmetric(vertical: 10),
                        ),
                        onSubmitted: (val) {
                          setState(() => _searchQuery = val);
                          _fetchRecords();
                        },
                      ),
                    ),
                    const SizedBox(height: 8),

                    // Status and Operational Shift Filter Row
                    Row(
                      children: [
                        Expanded(
                          child: Container(
                            height: 42,
                            padding: const EdgeInsets.symmetric(horizontal: 10),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: Colors.grey.shade200),
                            ),
                            child: DropdownButtonHideUnderline(
                              child: DropdownButton<String>(
                                value: _filterStatus,
                                isExpanded: true,
                                items: const [
                                  DropdownMenuItem(value: 'ALL', child: Text('All Status', style: TextStyle(fontSize: 12))),
                                  DropdownMenuItem(value: 'CLOSED', child: Text('Closed', style: TextStyle(fontSize: 12))),
                                  DropdownMenuItem(value: 'EXTENDED_DELAY', child: Text('Delays (>15m)', style: TextStyle(fontSize: 12))),
                                  DropdownMenuItem(value: 'OPEN', child: Text('Open', style: TextStyle(fontSize: 12))),
                                ],
                                onChanged: (val) {
                                  if (val != null) {
                                    setState(() => _filterStatus = val);
                                    _fetchRecords();
                                  }
                                },
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Container(
                            height: 42,
                            padding: const EdgeInsets.symmetric(horizontal: 10),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: Colors.grey.shade200),
                            ),
                            child: DropdownButtonHideUnderline(
                              child: DropdownButton<String>(
                                value: _filterShift,
                                isExpanded: true,
                                items: const [
                                  DropdownMenuItem(value: 'ALL', child: Text('All Shifts', style: TextStyle(fontSize: 12))),
                                  DropdownMenuItem(value: 'MORNING', child: Text('Morning (06-14)', style: TextStyle(fontSize: 12))),
                                  DropdownMenuItem(value: 'EVENING', child: Text('Evening (14-22)', style: TextStyle(fontSize: 12))),
                                  DropdownMenuItem(value: 'NIGHT', child: Text('Night (22-06)', style: TextStyle(fontSize: 12))),
                                ],
                                onChanged: (val) {
                                  if (val != null) {
                                    setState(() => _filterShift = val);
                                    _fetchRecords();
                                  }
                                },
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),

                    _buildCompleteLogList(),
                  ] else if (_reportType == 'count') ...[
                    _buildCountReportView(),
                  ] else if (_reportType == 'holistic') ...[
                    _buildHolisticReportView(),
                  ] else if (_reportType == 'attendance') ...[
                    _buildAttendanceReportView(),
                  ] else if (_reportType == 'attendance_exception') ...[
                    _buildAttendanceExceptionsView(),
                  ] else if (_reportType == 'device_mapping' && _isDeveloper) ...[
                    _buildDeviceMappingReportView(),
                  ] else ...[
                    _buildCycleAnalyticsView(),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _buildReportTypeSelector() {
    final tabs = [
      {'key': 'count', 'label': 'Count', 'icon': Icons.format_list_numbered_rounded, 'color': const Color(0xFF2563EB)},
      {'key': 'duration', 'label': 'Duration', 'icon': Icons.timer_outlined, 'color': const Color(0xFF046A38)},
      {'key': 'attendance', 'label': 'Muster', 'icon': Icons.badge_outlined, 'color': const Color(0xFF0284C7)},
      {'key': 'attendance_exception', 'label': 'Exceptions', 'icon': Icons.warning_amber_rounded, 'color': const Color(0xFFDC2626)},
      {'key': 'holistic', 'label': 'Holistic', 'icon': Icons.account_tree_outlined, 'color': const Color(0xFF7C3AED)},
      {'key': 'complete_log', 'label': 'Event Log', 'icon': Icons.table_rows_outlined, 'color': AppColors.primary},
    ];

    if (_isDeveloper) {
      tabs.add({
        'key': 'device_mapping',
        'label': 'Mapping',
        'icon': Icons.developer_board,
        'color': const Color(0xFFD97706),
      });
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        physics: const BouncingScrollPhysics(),
        child: Row(
          children: tabs.map((tab) {
            final isSelected = _reportType == tab['key'] || (_reportType == 'cycle' && tab['key'] == 'duration');
            final color = tab['color'] as Color;
            return Padding(
              padding: const EdgeInsets.only(right: 4),
              child: InkWell(
                onTap: () {
                  final k = tab['key'] as String;
                  if (_reportType != k) {
                    setState(() => _reportType = k);
                    if (k == 'count' && _countAnalytics == null) {
                      _fetchCountAnalytics();
                    } else if (k == 'duration' && _cycleAnalytics == null) {
                      _fetchCycleAnalytics();
                    } else if (k == 'holistic' && _holisticAnalytics == null) {
                      _fetchHolisticAnalytics();
                    } else if (k == 'attendance' && _attendanceData == null) {
                      _fetchAttendanceData();
                    } else if (k == 'attendance_exception' && _attendanceExceptionsData == null) {
                      _fetchAttendanceExceptions();
                    } else if (k == 'device_mapping' && _deviceMappingData == null) {
                      _fetchDeviceMapping();
                    } else if (k == 'complete_log' && _records.isEmpty) {
                      _fetchRecords();
                    }
                  }
                },
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  decoration: BoxDecoration(
                    color: isSelected ? color : Colors.transparent,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        tab['icon'] as IconData,
                        size: 14,
                        color: isSelected ? Colors.white : Colors.grey.shade700,
                      ),
                      const SizedBox(width: 5),
                      Text(
                        tab['label'] as String,
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.bold,
                          color: isSelected ? Colors.white : Colors.grey.shade700,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          }).toList(),
        ),
      ),
    );
  }

  Widget _buildCompleteLogList() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Logsheet Records (${_records.length})', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5)),
            PopupMenuButton<String>(
              tooltip: 'Sort order',
              icon: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.sort_rounded, size: 16, color: AppColors.primary),
                  const SizedBox(width: 4),
                  Text(_sortOrder.toUpperCase(), style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.primary)),
                ],
              ),
              onSelected: (val) {
                setState(() {
                  _sortOrder = val;
                });
                _fetchRecords();
              },
              itemBuilder: (ctx) => const [
                PopupMenuItem(value: 'desc', child: Text('Newest First (DESC)', style: TextStyle(fontSize: 12))),
                PopupMenuItem(value: 'asc', child: Text('Oldest First (ASC)', style: TextStyle(fontSize: 12))),
              ],
            ),
          ],
        ),
        const SizedBox(height: 6),
        if (_isLoadingRecords)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 40),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (_records.isEmpty)
          Container(
            padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 16),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.grey.shade200),
            ),
            child: Column(
              children: [
                Icon(Icons.door_sliding_outlined, size: 48, color: Colors.grey.shade400),
                const SizedBox(height: 12),
                const Text('No operational records found', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                const SizedBox(height: 4),
                Text(
                  'Try selecting more LC gates or widening the date range.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                ),
              ],
            ),
          )
        else
          ..._buildDatePartitionedLogCards(),
      ],
    );
  }

  List<Widget> _buildDatePartitionedLogCards() {
    final Map<String, List<dynamic>> grouped = {};
    for (final rec in _records) {
      String dateKey = (rec['openedDateIst'] ?? rec['openedDate'] ?? '').toString().trim();
      if (dateKey.isEmpty && rec['openedAt'] != null) {
        final istDt = OperationalRecord.parseToIst(rec['openedAt']);
        if (istDt != null) {
          dateKey = OperationalRecord.formatIstDate(istDt);
        }
      }
      if (dateKey.isEmpty) dateKey = 'Other / Incomplete';
      grouped.putIfAbsent(dateKey, () => []).add(rec);
    }

    final dateKeys = grouped.keys.toList();

    return dateKeys.expand((dateKey) {
      final recs = grouped[dateKey]!;
      return [
        Container(
          margin: const EdgeInsets.only(top: 8, bottom: 6),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: AppColors.primary.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.primary.withValues(alpha: 0.2)),
          ),
          child: Row(
            children: [
              const Icon(Icons.calendar_today_rounded, size: 13, color: AppColors.primary),
              const SizedBox(width: 6),
              Text(dateKey, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5, color: AppColors.primary)),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text('${recs.length} ops', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.primary)),
              ),
            ],
          ),
        ),
        ...recs.map((rec) => _buildRecordCard(rec)),
      ];
    }).toList();
  }

  Widget _buildCycleAnalyticsView() {
    if (_isLoadingCycle) {
      return Container(
        padding: const EdgeInsets.symmetric(vertical: 48),
        alignment: Alignment.center,
        child: Column(
          children: const [
            CircularProgressIndicator(color: Color(0xFF046A38)),
            SizedBox(height: 12),
            Text('Calculating operational cycles & durations...', style: TextStyle(fontSize: 12, color: Colors.grey)),
          ],
        ),
      );
    }

    if (_cycleAnalytics == null) {
      return Container(
        padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.grey.shade200),
        ),
        child: Column(
          children: [
            Icon(Icons.insights_rounded, size: 40, color: Colors.grey.shade400),
            const SizedBox(height: 10),
            const Text('No cycle analytics loaded', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5)),
            const SizedBox(height: 4),
            Text('Tap refresh or select LC gates to calculate cycle KPIs.', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
          ],
        ),
      );
    }

    final overall = (_cycleAnalytics!['overall'] as Map<String, dynamic>?) ?? {};
    final gateReports = (_cycleAnalytics!['gateReports'] as List?) ?? [];

    final totalCycles = overall['totalCycles'] ?? 0;
    final avgOpenFormatted =
        overall['avgOpenFormatted'] ?? overall['avgOpeningFormatted'] ?? '—';
    final avgClosedFormatted =
        overall['avgClosedFormatted'] ?? overall['avgClosingFormatted'] ?? '—';
    final reportingGatesCount = overall['reportingGatesCount'] ?? gateReports.length;

    final displayedReports = _selectedCycleGateId == null
        ? gateReports
        : gateReports.where((gr) => gr['gate']?['id'] == _selectedCycleGateId).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: _buildCycleKpiCard(
                'Completed Cycles',
                '$totalCycles',
                Icons.sync_rounded,
                const Color(0xFF046A38),
                'OPEN ➔ CLOSED ➔ OPEN',
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _buildCycleKpiCard(
                'Avg Open Time',
                '$avgOpenFormatted',
                Icons.hourglass_bottom_rounded,
                const Color(0xFF2563EB),
                'Mean open cycle duration',
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: _buildCycleKpiCard(
                'Avg Closed Time',
                '$avgClosedFormatted',
                Icons.schedule_rounded,
                const Color(0xFF059669),
                'Mean closed interval',
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _buildCycleKpiCard(
                'Reporting Gates',
                '$reportingGatesCount',
                Icons.domain_rounded,
                AppColors.primary,
                'Active monitored gates',
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),

        if (gateReports.length > 1) ...[
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    label: Text('All (${gateReports.length} Gates)', style: TextStyle(fontSize: 11, fontWeight: _selectedCycleGateId == null ? FontWeight.bold : FontWeight.normal, color: _selectedCycleGateId == null ? Colors.white : Colors.black87)),
                    selected: _selectedCycleGateId == null,
                    selectedColor: const Color(0xFF046A38),
                    backgroundColor: Colors.white,
                    visualDensity: VisualDensity.compact,
                    onSelected: (_) => setState(() => _selectedCycleGateId = null),
                  ),
                ),
                ...gateReports.map((gr) {
                  final g = gr['gate'] as Map<String, dynamic>? ?? {};
                  final gId = g['id'] as int?;
                  final kpis = gr['kpis'] as Map<String, dynamic>? ?? {};
                  final isSelected = _selectedCycleGateId == gId;
                  return Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: ChoiceChip(
                      label: Text('${g['lcNumber']} (${kpis['totalCycles'] ?? 0})', style: TextStyle(fontSize: 11, fontWeight: isSelected ? FontWeight.bold : FontWeight.normal, color: isSelected ? Colors.white : Colors.black87)),
                      selected: isSelected,
                      selectedColor: const Color(0xFF046A38),
                      backgroundColor: Colors.white,
                      visualDensity: VisualDensity.compact,
                      onSelected: (_) => setState(() => _selectedCycleGateId = gId),
                    ),
                  );
                }),
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],

        if (displayedReports.isEmpty)
          Container(
            padding: const EdgeInsets.all(24),
            alignment: Alignment.center,
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
            child: const Text('No operational cycles found for selected gate(s).', style: TextStyle(fontSize: 12, color: Colors.grey)),
          )
        else
          ...displayedReports.map((gr) => _buildGateCycleSection(gr)),
      ],
    );
  }

  Widget _buildCycleKpiCard(String label, String value, IconData icon, Color color, String sub) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Colors.grey.shade600), overflow: TextOverflow.ellipsis),
              ),
              Icon(icon, size: 15, color: color),
            ],
          ),
          const SizedBox(height: 4),
          Text(value, style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: color)),
          const SizedBox(height: 2),
          Text(sub, style: TextStyle(fontSize: 9.5, color: Colors.grey.shade500), overflow: TextOverflow.ellipsis),
        ],
      ),
    );
  }

  Widget _buildGateCycleSection(dynamic gr) {
    final gate = (gr['gate'] as Map<String, dynamic>?) ?? {};
    final kpis = (gr['kpis'] as Map<String, dynamic>?) ?? {};
    final days = (gr['dailyBreakdown'] as List?) ?? [];

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFF046A38).withValues(alpha: 0.05),
              borderRadius: const BorderRadius.vertical(top: Radius.circular(12)),
              border: Border(bottom: BorderSide(color: Colors.grey.shade200)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              gate['lcNumber'] ?? 'LC',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF046A38)),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          if (gate['name'] != null && gate['name'].toString().isNotEmpty) ...[
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                '• ${gate['name']}',
                                style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${gate['locationName'] ?? ''}${gate['division'] != null ? ' • ${gate['division']} Div' : ''}${gate['zone'] != null ? ' (${gate['zone']})' : ''}',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: const Color(0xFF046A38),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    '${kpis['totalCycles'] ?? 0} Cycles',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 11),
                  ),
                ),
              ],
            ),
          ),
          if (days.isEmpty)
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('No operating cycles recorded in this date range.', style: TextStyle(fontSize: 11.5, color: Colors.grey)),
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: days.length,
              separatorBuilder: (ctx, i) => const Divider(height: 1),
              itemBuilder: (ctx, i) {
                final d = days[i] as Map<String, dynamic>;
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(d['dateFormatted'] ?? d['dateStr'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12), overflow: TextOverflow.ellipsis),
                            const SizedBox(height: 2),
                            Text(
                              'Open: ${d['totalOpenFormatted'] ?? '0s'} • Closed: ${d['totalClosedFormatted'] ?? '0s'}',
                              style: TextStyle(fontSize: 10.5, color: Colors.grey.shade600),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: const Color(0xFF046A38).withValues(alpha: 0.1),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              '${d['completedCycles']} cycles',
                              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF046A38)),
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Avg open: ${d['avgOpenFormatted'] ?? d['avgOpeningFormatted'] ?? '—'}',
                            style: TextStyle(fontSize: 10, color: Colors.grey.shade600),
                          ),
                        ],
                      ),
                    ],
                  ),
                );
              },
            ),
        ],
      ),
    );
  }

  Widget _buildPresetChip(String key, String label) {
    final isSelected = _activePreset == key;
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: ChoiceChip(
        label: Text(label, style: TextStyle(fontSize: 11, fontWeight: isSelected ? FontWeight.bold : FontWeight.normal, color: isSelected ? Colors.white : Colors.black87)),
        selected: isSelected,
        selectedColor: AppColors.primary,
        backgroundColor: Colors.grey.shade100,
        visualDensity: VisualDensity.compact,
        onSelected: (_) => _applyDatePreset(key),
      ),
    );
  }

  Widget _buildRecordCard(dynamic rec) {
    final status = (rec['status'] ?? 'CLOSED').toString();
    Color statusColor = const Color(0xFF15803D);
    Color statusBg = const Color(0xFFDCFCE7);

    if (status == 'EXTENDED_DELAY') {
      statusColor = const Color(0xFFB45309);
      statusBg = const Color(0xFFFEF3C7);
    } else if (status == 'OPEN') {
      statusColor = const Color(0xFFB91C1C);
      statusBg = const Color(0xFFFEE2E2);
    }

    String openedAtStr = (rec['openedTimeIst'] ?? '').toString().trim();
    if (openedAtStr.isEmpty && rec['openedAt'] != null) {
      final istOpened = OperationalRecord.parseToIst(rec['openedAt']);
      openedAtStr = istOpened != null ? OperationalRecord.formatIstTime(istOpened) : '-';
    }
    if (openedAtStr.isEmpty) openedAtStr = '-';

    String closedAtStr = (rec['closedTimeIst'] ?? '').toString().trim();
    if (closedAtStr.isEmpty) {
      if (rec['closedAt'] != null) {
        final istClosed = OperationalRecord.parseToIst(rec['closedAt']);
        closedAtStr = istClosed != null ? OperationalRecord.formatIstTime(istClosed) : 'OPEN';
      } else {
        closedAtStr = 'OPEN';
      }
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: Text(
                        rec['lcNumber'] ?? 'LC',
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5, color: AppColors.primary),
                      ),
                    ),
                    if (rec['masterSerial'] != null && rec['masterSerial'].toString().trim().isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: const Color(0xFFE0E7FF),
                          borderRadius: BorderRadius.circular(4),
                          border: Border.all(color: const Color(0xFFC7D2FE)),
                        ),
                        child: Text(
                          rec['masterSerial'].toString().replaceAll(RegExp(r'^#+'), ''),
                          style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: Color(0xFF3730A3)),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: statusBg, borderRadius: BorderRadius.circular(12)),
                child: Text(status, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: statusColor)),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(rec['locationName'] ?? '', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Opened: $openedAtStr', style: const TextStyle(fontSize: 11.5, fontFamily: 'monospace')),
              Text('Closed: $closedAtStr', style: const TextStyle(fontSize: 11.5, fontFamily: 'monospace')),
              Text('${rec['durationFormatted'] ?? '-'}', style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSyncStatusBadge() {
    Color bg = const Color(0xFFF1F5F9);
    Color fg = const Color(0xFF475569);
    Color dotColor = Colors.grey;
    String label = 'Offline';

    if (_syncStatus == 'updating' || _isRevalidating || _isSyncing) {
      bg = const Color(0xFFEFF6FF);
      fg = const Color(0xFF1D4ED8);
      dotColor = const Color(0xFF3B82F6);
      label = 'Syncing...';
    } else if (_syncStatus == 'synced') {
      bg = const Color(0xFFECFDF5);
      fg = const Color(0xFF047857);
      dotColor = const Color(0xFF10B981);
      label = 'Live';
    } else if (_syncStatus == 'outdated') {
      bg = const Color(0xFFFEF3C7);
      fg = const Color(0xFFB45309);
      dotColor = const Color(0xFFF59E0B);
      label = 'Cached';
    }

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 14, horizontal: 4),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: dotColor.withValues(alpha: 0.3)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle),
          ),
          const SizedBox(width: 4),
          Text(label, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: fg)),
        ],
      ),
    );
  }

  Widget _buildKpiSection() {
    final totalOps = _metrics['totalOperations'] ?? _records.length;
    final totalDuration = _metrics['totalDurationFormatted'] ?? '0s';
    final avgDuration = _metrics['avgDurationFormatted'] ?? '0s';
    final extendedDelays = _metrics['extendedDelaysCount'] ?? 0;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(child: _buildCycleKpiCard('Total Ops', '$totalOps', Icons.alt_route_rounded, const Color(0xFF003580), 'Total events logged')),
              const SizedBox(width: 8),
              Expanded(child: _buildCycleKpiCard('Total Duration', '$totalDuration', Icons.timer_outlined, const Color(0xFF2563EB), 'Cumulative duration')),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(child: _buildCycleKpiCard('Avg Duration', '$avgDuration', Icons.speed_rounded, const Color(0xFF10B981), 'Average per operation')),
              const SizedBox(width: 8),
              Expanded(child: _buildCycleKpiCard('Delays (>15m)', '$extendedDelays', Icons.warning_amber_rounded, const Color(0xFFEF4444), 'Extended blockage')),
            ],
          ),
        ],
      ),
    );
  }

  // =========================================================================
  // COUNT REPORT VIEW
  // =========================================================================
  Widget _buildCountReportView() {
    if (_isLoadingCount) {
      return Container(
        padding: const EdgeInsets.symmetric(vertical: 48),
        alignment: Alignment.center,
        child: Column(
          children: const [
            CircularProgressIndicator(color: Color(0xFF2563EB)),
            SizedBox(height: 12),
            Text('Aggregating operations across railway hierarchy...', style: TextStyle(fontSize: 12, color: Colors.grey)),
          ],
        ),
      );
    }

    if (_countAnalytics == null) {
      return Container(
        padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.grey.shade200),
        ),
        child: Column(
          children: [
            Icon(Icons.format_list_numbered_rounded, size: 40, color: Colors.grey.shade400),
            const SizedBox(height: 10),
            const Text('No count analytics loaded', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5)),
            const SizedBox(height: 4),
            Text('Tap refresh to compute opening & closing counts.', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
          ],
        ),
      );
    }

    final summary = (_countAnalytics!['kpis'] as Map<String, dynamic>?) ??
        (_countAnalytics!['summary'] as Map<String, dynamic>?) ?? {};
    final totalOps = summary['totalOperations'] ?? 0;
    final totalOpen = summary['totalOpenCount'] ?? 0;
    final totalClose = summary['totalCloseCount'] ?? 0;
    final activeGates = summary['reportingGatesCount'] ?? summary['activeGatesCount'] ?? 0;

    final gateReports = (_countAnalytics!['gates'] as List?) ??
        (_countAnalytics!['gateReports'] as List?) ?? [];
    final divisionBreakdown = (_countAnalytics!['divisions'] as List?) ??
        (_countAnalytics!['divisionBreakdown'] as List?) ?? [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Summary KPI row
        Row(
          children: [
            Expanded(child: _buildCycleKpiCard('Total Ops', '$totalOps', Icons.alt_route_rounded, const Color(0xFF2563EB), 'Logged gate cycles')),
            const SizedBox(width: 8),
            Expanded(child: _buildCycleKpiCard('Openings', '$totalOpen', Icons.lock_open_rounded, const Color(0xFF10B981), 'Barrier opens')),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(child: _buildCycleKpiCard('Closings', '$totalClose', Icons.lock_outline_rounded, const Color(0xFFEF4444), 'Barrier closes')),
            const SizedBox(width: 8),
            Expanded(child: _buildCycleKpiCard('Active Gates', '$activeGates', Icons.grid_view_rounded, const Color(0xFF8B5CF6), 'Reporting gates')),
          ],
        ),
        const SizedBox(height: 14),

        // Gate-wise Breakdown Table
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Colors.grey.shade200),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Gate-wise Operation Counts', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  Text('${gateReports.length} gates', style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                ],
              ),
              const Divider(height: 16),
              ...gateReports.map((gr) {
                final gate = (gr['gate'] as Map<String, dynamic>?) ?? gr;
                final gateNo = gr['lcNumber'] ?? gate['lcNumber'] ?? gate['gateNumber'] ?? 'LC Gate';
                final station = gr['stationName'] ?? gate['station'] ?? gate['locationName'] ?? '—';
                final div = gr['division'] ?? gate['division'] ?? '—';
                final gOpen = gr['openCount'] ?? 0;
                final gClose = gr['closeCount'] ?? 0;
                final gTotal = gr['totalOperations'] ?? 0;

                return Container(
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Colors.grey.shade50,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.grey.shade200),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('$gateNo', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)), overflow: TextOverflow.ellipsis),
                            Text('$station Station · $div', style: TextStyle(fontSize: 11, color: Colors.grey.shade600), overflow: TextOverflow.ellipsis),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _buildMiniBadge('Open', '$gOpen', const Color(0xFF10B981)),
                          const SizedBox(width: 4),
                          _buildMiniBadge('Close', '$gClose', const Color(0xFFEF4444)),
                          const SizedBox(width: 4),
                          _buildMiniBadge('Total', '$gTotal', const Color(0xFF2563EB)),
                        ],
                      ),
                    ],
                  ),
                );
              }),
            ],
          ),
        ),
        const SizedBox(height: 12),

        // Station & Division Hierarchy Summary
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Colors.grey.shade200),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Division & Station Rollups', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
              const Divider(height: 16),
              ...divisionBreakdown.map((div) {
                final divName = div['division'] ?? '—';
                final divTotal = div['totalOperations'] ?? 0;
                final divGates = div['gatesCount'] ?? div['gateCount'] ?? 0;
                final divStations = div['stationCount'] ?? 0;

                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          '$divName Division ($divStations stations, $divGates gates)',
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text('$divTotal ops', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF2563EB))),
                    ],
                  ),
                );
              }),
            ],
          ),
        ),
      ],
    );
  }

  // =========================================================================
  // HOLISTIC MANAGEMENT REPORT VIEW
  // =========================================================================
  Widget _buildHolisticReportView() {
    if (_isLoadingHolistic) {
      return Container(
        padding: const EdgeInsets.symmetric(vertical: 48),
        alignment: Alignment.center,
        child: Column(
          children: const [
            CircularProgressIndicator(color: Color(0xFF7C3AED)),
            SizedBox(height: 12),
            Text('Generating consolidated executive management report...', style: TextStyle(fontSize: 12, color: Colors.grey)),
          ],
        ),
      );
    }

    if (_holisticAnalytics == null) {
      return Container(
        padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.grey.shade200),
        ),
        child: Column(
          children: [
            Icon(Icons.account_tree_outlined, size: 40, color: Colors.grey.shade400),
            const SizedBox(height: 10),
            const Text('No holistic analytics loaded', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5)),
            const SizedBox(height: 4),
            Text('Tap refresh to compile hierarchical counts and durations.', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
          ],
        ),
      );
    }

    final summary = (_holisticAnalytics!['kpis'] as Map<String, dynamic>?) ??
        (_holisticAnalytics!['summary'] as Map<String, dynamic>?) ?? {};
    final totalOps = summary['totalOperations'] ?? 0;
    final totalOpen = summary['totalOpenFormatted'] ?? '0s';
    final avgOpen = summary['avgOpenFormatted'] ?? summary['avgOpenDurationFormatted'] ?? '0s';
    final delays = summary['totalExtendedDelays'] ?? summary['extendedDelaysCount'] ?? 0;
    final tree = (_holisticAnalytics!['hierarchy'] as List?) ??
        (_holisticAnalytics!['tree'] as List?) ?? [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Executive KPI Cards
        Row(
          children: [
            Expanded(child: _buildCycleKpiCard('Total Operations', '$totalOps', Icons.alt_route_rounded, const Color(0xFF7C3AED), 'Network Total')),
            const SizedBox(width: 8),
            Expanded(child: _buildCycleKpiCard('Total Open Time', '$totalOpen', Icons.timer_outlined, const Color(0xFF2563EB), 'Network Open Window')),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(child: _buildCycleKpiCard('Avg Open Duration', '$avgOpen', Icons.speed_rounded, const Color(0xFF046A38), 'Per Open Operation')),
            const SizedBox(width: 8),
            Expanded(child: _buildCycleKpiCard('Delays (>15m)', '$delays', Icons.warning_amber_rounded, const Color(0xFFEF4444), 'Extended Closures')),
          ],
        ),
        const SizedBox(height: 14),

        // Consolidated Hierarchy Drilldown Tree
        Text('Executive Drilldown Hierarchy (Zone ➔ Division ➔ Station ➔ Gate)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.grey.shade700)),
        const SizedBox(height: 8),

        ...tree.map((zoneObj) {
          final zoneName = zoneObj['zone'] ?? 'Unknown Zone';
          final zGates = zoneObj['gatesCount'] ?? zoneObj['totalGates'] ?? 0;
          final zOps = zoneObj['totalOperations'] ?? 0;
          final zOpen = zoneObj['totalOpenFormatted'] ?? '0s';
          final divisions = (zoneObj['divisions'] as List?) ?? [];

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            elevation: 0.5,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: Colors.grey.shade200)),
            child: ExpansionTile(
              initiallyExpanded: true,
              leading: const Icon(Icons.public, color: Color(0xFF7C3AED)),
              title: Text('$zoneName Zone', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
              subtitle: Text('$zGates Gates · $zOps Ops · $zOpen Open Window', style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
              children: divisions.map((divObj) {
                final divName = divObj['division'] ?? 'Unknown Division';
                final dGates = divObj['gatesCount'] ?? divObj['totalGates'] ?? 0;
                final dOps = divObj['totalOperations'] ?? 0;
                final stations = (divObj['stations'] as List?) ?? [];

                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Card(
                    color: Colors.grey.shade50,
                    elevation: 0,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8), side: BorderSide(color: Colors.grey.shade200)),
                    child: ExpansionTile(
                      initiallyExpanded: true,
                      title: Text('$divName Division', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                      subtitle: Text('$dGates Gates · $dOps Operations', style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                      children: stations.map((stObj) {
                        final stName = stObj['stationName'] ?? stObj['station'] ?? 'Station';
                        final sOps = stObj['totalOperations'] ?? 0;
                        final gates = (stObj['gates'] as List?) ?? [];

                        return Container(
                          padding: const EdgeInsets.all(8),
                          margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(6)),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Expanded(
                                    child: Text('$stName Station', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12), overflow: TextOverflow.ellipsis),
                                  ),
                                  const SizedBox(width: 8),
                                  Text('$sOps Total Ops', style: const TextStyle(fontSize: 11, color: Color(0xFF7C3AED), fontWeight: FontWeight.bold)),
                                ],
                              ),
                              const SizedBox(height: 6),
                              ...gates.map((g) {
                                final gNo = g['lcNumber'] ?? g['gateNumber'] ?? 'LC';
                                final gOpen = g['openCount'] ?? 0;
                                final gClose = g['closeCount'] ?? 0;
                                final gAvg = g['avgOpenFormatted'] ?? g['avgOpenDurationFormatted'] ?? '—';
                                return Padding(
                                  padding: const EdgeInsets.symmetric(vertical: 2),
                                  child: Row(
                                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                    children: [
                                      Expanded(
                                        child: Text(' • $gNo', style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w500), overflow: TextOverflow.ellipsis),
                                      ),
                                      const SizedBox(width: 8),
                                      Text('Open: $gOpen | Close: $gClose | Avg: $gAvg', style: TextStyle(fontSize: 10.5, color: Colors.grey.shade700)),
                                    ],
                                  ),
                                );
                              }),
                            ],
                          ),
                        );
                      }).toList(),
                    ),
                  ),
                );
              }).toList(),
            ),
          );
        }),
      ],
    );
  }

  Widget _buildMiniBadge(String label, String value, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        '$label: $value',
        style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: color),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 6. DEVELOPER ONLY: GATE & DEVICE CONNECTIVITY MAPPING REGISTRY
  // ─────────────────────────────────────────────────────────────
  Widget _buildDeviceMappingReportView() {
    if (_isLoadingDeviceMapping) {
      return const Padding(
        padding: EdgeInsets.all(40),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(strokeWidth: 2.5),
              SizedBox(height: 14),
              Text(
                'Compiling Developer Hardware & IoT Mapping...',
                style: TextStyle(fontSize: 13, color: Color(0xFF64748B), fontWeight: FontWeight.w500),
              ),
            ],
          ),
        ),
      );
    }

    final rawRows = (_deviceMappingData?['rows'] as List?) ?? [];
    final totalMapped = _deviceMappingData?['totalDevices'] ?? rawRows.length;
    final assignedCount = rawRows.where((r) => (r['lcGateNumber'] ?? '').toString().toLowerCase() != 'unassigned').length;
    final unassignedCount = rawRows.where((r) => (r['lcGateNumber'] ?? '').toString().toLowerCase() == 'unassigned').length;

    // Filter strictly by LC Gate (number or location name)
    final query = _mappingSearchQuery.toLowerCase().trim();
    final rows = rawRows.where((r) {
      final gateNumber = (r['lcGateNumber'] ?? '').toString().toLowerCase();
      final locationName = (r['locationName'] ?? '').toString().toLowerCase();
      final isUnassigned = gateNumber == 'unassigned';

      // 1. Quick Gate Status Filter (all, assigned, unassigned)
      if (_mappingGateFilterType == 'assigned' && isUnassigned) return false;
      if (_mappingGateFilterType == 'unassigned' && !isUnassigned) return false;

      // 2. Strict LC Gate Query Match (matches only gate number or location name)
      if (query.isNotEmpty) {
        final matchesGate = gateNumber.contains(query) || locationName.contains(query);
        if (!matchesGate) return false;
      }
      return true;
    }).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 1. Developer Header Card
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFD97706).withValues(alpha: 0.3)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.02),
                blurRadius: 6,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: const Color(0xFFD97706).withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Icon(Icons.developer_board, color: Color(0xFFD97706), size: 22),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Gate & IoT Controller Mapping Registry',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14.5, color: Color(0xFF0F172A)),
                        ),
                        Text(
                          'Restricted Developer hardware inventory linking LC Gate, Master Unit, AWS IoT Thing & SIM ICCID',
                          style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: const Color(0xFF003580).withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      'TOTAL CONTROLLERS: $totalMapped',
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF003580)),
                    ),
                  ),
                  ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF107C41),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      textStyle: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      elevation: 0,
                    ),
                    icon: const Icon(Icons.table_view_rounded, size: 16),
                    label: const Text('Export Excel'),
                    onPressed: () {
                      _startExportWithProgress(
                        parentCtx: context,
                        selectedReportType: 'device_mapping',
                        selectedFormat: 'xlsx',
                        selectedCols: {},
                      );
                    },
                  ),
                  ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFFE11D48),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      textStyle: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      elevation: 0,
                    ),
                    icon: const Icon(Icons.picture_as_pdf_rounded, size: 16),
                    label: const Text('Export PDF'),
                    onPressed: () {
                      _startExportWithProgress(
                        parentCtx: context,
                        selectedReportType: 'device_mapping',
                        selectedFormat: 'pdf',
                        selectedCols: {},
                      );
                    },
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),

        // 1.5. Quick Gate Status Filter Chips
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              _buildMappingFilterChip(
                label: 'All Gates ($totalMapped)',
                isActive: _mappingGateFilterType == 'all',
                onTap: () => setState(() => _mappingGateFilterType = 'all'),
              ),
              const SizedBox(width: 8),
              _buildMappingFilterChip(
                label: 'Assigned Gates ($assignedCount)',
                isActive: _mappingGateFilterType == 'assigned',
                onTap: () => setState(() => _mappingGateFilterType = 'assigned'),
              ),
              const SizedBox(width: 8),
              _buildMappingFilterChip(
                label: 'Unassigned ($unassignedCount)',
                isActive: _mappingGateFilterType == 'unassigned',
                onTap: () => setState(() => _mappingGateFilterType = 'unassigned'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),

        // 2. Search Filter Input (Strictly Gate Filter)
        Container(
          height: 42,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: Colors.grey.shade200),
          ),
          child: TextField(
            controller: _mappingSearchCtrl,
            decoration: InputDecoration(
              hintText: 'Filter by LC Gate (e.g. LC-63, Satara)...',
              hintStyle: const TextStyle(fontSize: 12),
              prefixIcon: const Icon(Icons.search, size: 18, color: Colors.grey),
              suffixIcon: _mappingSearchQuery.isNotEmpty
                  ? IconButton(
                      icon: const Icon(Icons.close, size: 16),
                      onPressed: () {
                        _mappingSearchCtrl.clear();
                        setState(() => _mappingSearchQuery = '');
                      },
                    )
                  : null,
              border: InputBorder.none,
              contentPadding: const EdgeInsets.symmetric(vertical: 10),
            ),
            onChanged: (val) {
              setState(() => _mappingSearchQuery = val);
            },
          ),
        ),
        const SizedBox(height: 12),

        // 3. Mapping Table
        if (rows.isEmpty)
          Container(
            padding: const EdgeInsets.all(24),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: Colors.grey.shade200),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.search_off_rounded, size: 36, color: Colors.grey),
                const SizedBox(height: 8),
                Text(
                  query.isEmpty ? 'No LC gates found for selected filter.' : 'No LC gates match "$query".',
                  style: const TextStyle(fontSize: 13, color: Colors.grey),
                ),
                if (query.isNotEmpty || _mappingGateFilterType != 'all') ...[
                  const SizedBox(height: 10),
                  TextButton.icon(
                    icon: const Icon(Icons.refresh, size: 16),
                    label: const Text('Reset Gate Filter'),
                    onPressed: () {
                      _mappingSearchCtrl.clear();
                      setState(() {
                        _mappingSearchQuery = '';
                        _mappingGateFilterType = 'all';
                      });
                    },
                  ),
                ],
              ],
            ),
          )
        else
          Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: Colors.grey.shade200),
              boxShadow: [
                BoxShadow(color: Colors.black.withValues(alpha: 0.02), blurRadius: 4, offset: const Offset(0, 1)),
              ],
            ),
            clipBehavior: Clip.antiAlias,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: DataTable(
                headingRowColor: WidgetStateProperty.all(const Color(0xFF1E293B)),
                headingTextStyle: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white, fontSize: 11),
                dataTextStyle: const TextStyle(fontSize: 11.5, color: Color(0xFF0F172A)),
                columnSpacing: 18,
                horizontalMargin: 14,
                headingRowHeight: 38,
                dataRowMinHeight: 38,
                dataRowMaxHeight: 44,
                columns: const [
                  DataColumn(label: Text('S.No.')),
                  DataColumn(label: Text('LC Gate')),
                  DataColumn(label: Text('Division / Zone')),
                  DataColumn(label: Text('Master Unit Serial (ID)')),
                  DataColumn(label: Text('AWS IoT Thing')),
                  DataColumn(label: Text('SIM Details')),
                  DataColumn(label: Text('SIM ICCID')),
                ],
                rows: rows.asMap().entries.map((entry) {
                  final idx = entry.key;
                  final r = entry.value;
                  final isEven = idx % 2 == 0;
                  final simDetails = (r['simDetails'] ?? '-').toString();
                  final divZone = (r['division'] != null && r['zone'] != null)
                      ? '${r['division']} · ${r['zone']}'
                      : (r['division'] ?? r['zone'] ?? '-');

                  return DataRow(
                    color: WidgetStateProperty.all(isEven ? Colors.white : const Color(0xFFF8FAFC)),
                    cells: [
                      DataCell(Text('${r['sNo'] ?? idx + 1}', style: const TextStyle(color: Colors.grey))),
                      DataCell(Text(r['lcGateNumber'] ?? '-', style: const TextStyle(fontWeight: FontWeight.bold))),
                      DataCell(Text(divZone, style: const TextStyle(color: Color(0xFF475569)))),
                      DataCell(Text(
                        r['masterSerialNumber'] ?? '-',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF0B3C7A)),
                      )),
                      DataCell(Text(
                        r['awsIotThingName'] ?? '-',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF0B3C7A)),
                      )),
                      DataCell(
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: const Color(0xFF046A38).withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            simDetails,
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 10.5, color: Color(0xFF046A38)),
                          ),
                        ),
                      ),
                      DataCell(Text(
                        r['iccid'] ?? '-',
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: Color(0xFF334155)),
                      )),
                    ],
                  );
                }).toList(),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildMappingFilterChip({
    required String label,
    required bool isActive,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: isActive ? const Color(0xFFD97706) : Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: isActive ? const Color(0xFFD97706) : Colors.grey.shade300,
            width: 1.2,
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: isActive ? FontWeight.bold : FontWeight.w500,
            color: isActive ? Colors.white : const Color(0xFF334155),
          ),
        ),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 7. ATTENDANCE MUSTER & EXCEPTION AUDIT REPORT INTEGRATION
  // ─────────────────────────────────────────────────────────────

  Future<void> _fetchAttendanceData({bool forceReload = false}) async {
    if (!mounted) return;
    setState(() => _isLoadingAttendance = true);
    try {
      final start = _formatDate(_dateRange.start);
      final end = _formatDate(_dateRange.end);
      final queryParams = <String, String>{
        'startDate': start,
        'endDate': end,
      };
      if (_selectedGateIds.length == 1) {
        queryParams['gateId'] = _selectedGateIds.first.toString();
      }
      final uri = Uri.parse('$baseUrl/reports/attendance').replace(queryParameters: queryParams);
      final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && mounted) {
        setState(() {
          _attendanceData = json.decode(res.body);
          _isLoadingAttendance = false;
        });
      } else {
        if (mounted) setState(() => _isLoadingAttendance = false);
      }
    } catch (e) {
      if (mounted) setState(() => _isLoadingAttendance = false);
    }
  }

  Future<void> _fetchAttendanceExceptions({bool forceReload = false}) async {
    if (!mounted) return;
    setState(() => _isLoadingAttendanceExceptions = true);
    try {
      final start = _formatDate(_dateRange.start);
      final end = _formatDate(_dateRange.end);
      final queryParams = <String, String>{
        'startDate': start,
        'endDate': end,
      };
      if (_selectedGateIds.length == 1) {
        queryParams['gateId'] = _selectedGateIds.first.toString();
      }
      final uri = Uri.parse('$baseUrl/reports/attendance-exceptions').replace(queryParameters: queryParams);
      final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && mounted) {
        setState(() {
          _attendanceExceptionsData = json.decode(res.body);
          _isLoadingAttendanceExceptions = false;
        });
      } else {
        if (mounted) setState(() => _isLoadingAttendanceExceptions = false);
      }
    } catch (e) {
      if (mounted) setState(() => _isLoadingAttendanceExceptions = false);
    }
  }

  // ── 7.1. ATTENDANCE MUSTER VIEW ──
  Widget _buildAttendanceReportView() {
    if (_isLoadingAttendance) {
      return const Padding(
        padding: EdgeInsets.all(40),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(strokeWidth: 2.5, color: Color(0xFF0284C7)),
              SizedBox(height: 14),
              Text(
                'Compiling Shift Attendance Muster & Geofence Logs...',
                style: TextStyle(fontSize: 13, color: Color(0xFF64748B), fontWeight: FontWeight.w500),
              ),
            ],
          ),
        ),
      );
    }

    final metrics = (_attendanceData?['metrics'] as Map<String, dynamic>?) ?? {};
    final rawRecords = (_attendanceData?['records'] as List?) ?? [];

    final query = _attendanceSearchQuery.toLowerCase().trim();
    final records = rawRecords.where((r) {
      final user = (r['user'] as Map?) ?? {};
      final gate = (r['gate'] as Map?) ?? {};
      final userName = (user['fullName'] ?? '').toString().toLowerCase();
      final empId = (user['employeeId'] ?? '').toString().toLowerCase();
      final gateNo = (gate['lcNumber'] ?? '').toString().toLowerCase();
      final loc = (gate['locationName'] ?? '').toString().toLowerCase();
      final status = (r['dutyStatus'] ?? '').toString().toUpperCase();

      if (_attendanceStatusFilter != 'ALL' && status != _attendanceStatusFilter) {
        return false;
      }

      if (query.isNotEmpty) {
        return userName.contains(query) || empId.contains(query) || gateNo.contains(query) || loc.contains(query);
      }
      return true;
    }).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 1. Attendance KPI Header Card
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFF0284C7).withValues(alpha: 0.3)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.02),
                blurRadius: 6,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0284C7).withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Icon(Icons.badge_outlined, color: Color(0xFF0284C7), size: 22),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Duty Attendance & Shift Muster',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14.5, color: Color(0xFF0F172A)),
                        ),
                        Text(
                          'Biometric check-in/out telemetry, geofence audit & net duty duration',
                          style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              // KPI Strip
              Row(
                children: [
                  _buildAttendanceKpiBadge('Total Shifts', '${metrics['totalSessions'] ?? 0}', const Color(0xFF003580)),
                  const SizedBox(width: 6),
                  _buildAttendanceKpiBadge('Completed', '${metrics['completedSessions'] ?? 0}', const Color(0xFF046A38)),
                  const SizedBox(width: 6),
                  _buildAttendanceKpiBadge('On Duty', '${metrics['currentlyOnDuty'] ?? 0}', const Color(0xFF0284C7)),
                  const SizedBox(width: 6),
                  _buildAttendanceKpiBadge('Late', '${metrics['lateSessions'] ?? 0}', const Color(0xFFDC2626)),
                  const SizedBox(width: 6),
                  _buildAttendanceKpiBadge('On-Time', '${metrics['onTimePercentage'] ?? 100}%', const Color(0xFF7C3AED)),
                ],
              ),
              const SizedBox(height: 12),
              // Export Actions
              Row(
                children: [
                  Expanded(
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF107C41),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        textStyle: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        elevation: 0,
                      ),
                      icon: const Icon(Icons.table_view_rounded, size: 16),
                      label: const Text('Export Excel'),
                      onPressed: () {
                        _startExportWithProgress(
                          parentCtx: context,
                          selectedReportType: 'attendance',
                          selectedFormat: 'xlsx',
                          selectedCols: {},
                        );
                      },
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFFE11D48),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        textStyle: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        elevation: 0,
                      ),
                      icon: const Icon(Icons.picture_as_pdf_rounded, size: 16),
                      label: const Text('Export PDF'),
                      onPressed: () {
                        _startExportWithProgress(
                          parentCtx: context,
                          selectedReportType: 'attendance',
                          selectedFormat: 'pdf',
                          selectedCols: {},
                        );
                      },
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),

        // Search & Filter Strip
        Row(
          children: [
            Expanded(
              child: Container(
                height: 40,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.grey.shade300),
                ),
                child: TextField(
                  controller: _attendanceSearchCtrl,
                  decoration: InputDecoration(
                    hintText: 'Search staff name, LC gate, emp ID...',
                    hintStyle: TextStyle(fontSize: 11.5, color: Colors.grey.shade500),
                    prefixIcon: const Icon(Icons.search, size: 18),
                    suffixIcon: _attendanceSearchQuery.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.clear, size: 16),
                            onPressed: () {
                              _attendanceSearchCtrl.clear();
                              setState(() => _attendanceSearchQuery = '');
                            },
                          )
                        : null,
                    border: InputBorder.none,
                    contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                  onChanged: (val) => setState(() => _attendanceSearchQuery = val),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Container(
              height: 40,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.grey.shade300),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: _attendanceStatusFilter,
                  items: const [
                    DropdownMenuItem(value: 'ALL', child: Text('All Status', style: TextStyle(fontSize: 12))),
                    DropdownMenuItem(value: 'COMPLETED', child: Text('Completed', style: TextStyle(fontSize: 12))),
                    DropdownMenuItem(value: 'ON_DUTY', child: Text('On Duty', style: TextStyle(fontSize: 12))),
                    DropdownMenuItem(value: 'LATE', child: Text('Late', style: TextStyle(fontSize: 12))),
                  ],
                  onChanged: (val) {
                    if (val != null) setState(() => _attendanceStatusFilter = val);
                  },
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),

        // Records List
        if (records.isEmpty)
          Container(
            padding: const EdgeInsets.all(32),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.grey.shade200),
            ),
            child: Column(
              children: [
                Icon(Icons.event_busy, size: 38, color: Colors.grey.shade400),
                const SizedBox(height: 8),
                const Text('No Attendance Records Found', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF64748B))),
                const SizedBox(height: 4),
                Text('Adjust date range or gate filter to view shifts', style: TextStyle(fontSize: 11, color: Colors.grey.shade500)),
              ],
            ),
          )
        else
          ...records.map((r) => _buildAttendanceSessionCard(r)),
      ],
    );
  }

  Widget _buildAttendanceKpiBadge(String label, String value, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: color.withValues(alpha: 0.2)),
        ),
        child: Column(
          children: [
            Text(value, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: color)),
            const SizedBox(height: 2),
            Text(label, style: TextStyle(fontSize: 9.5, color: Colors.grey.shade700, fontWeight: FontWeight.w500), textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }

  Widget _buildAttendanceSessionCard(Map<String, dynamic> r) {
    final user = (r['user'] as Map?) ?? {};
    final gate = (r['gate'] as Map?) ?? {};
    final shift = (r['shift'] as Map?) ?? {};
    final checkIn = (r['checkIn'] as Map?);
    final checkOut = (r['checkOut'] as Map?);
    final status = (r['dutyStatus'] ?? 'COMPLETED').toString();

    Color statusColor;
    String statusLabel;
    if (status == 'COMPLETED') {
      statusColor = const Color(0xFF046A38);
      statusLabel = 'COMPLETED';
    } else if (status == 'ON_DUTY') {
      statusColor = const Color(0xFF0284C7);
      statusLabel = 'ON DUTY';
    } else if (status == 'LATE') {
      statusColor = const Color(0xFFD97706);
      statusLabel = 'LATE ENTRY';
    } else {
      statusColor = const Color(0xFFDC2626);
      statusLabel = status;
    }

    final isLate = checkIn != null && (checkIn['minutesLate'] ?? 0) > 0;
    final minutesLate = checkIn != null ? (checkIn['minutesLate'] ?? 0) : 0;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0.5,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: Colors.grey.shade200)),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Row 1: Gate & Shift badges + Status pill
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFF003580),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    gate['lcNumber'] ?? 'LC',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 11),
                  ),
                ),
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF1F5F9),
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: Colors.grey.shade300),
                  ),
                  child: Text(
                    shift['code'] ?? shift['name'] ?? 'Shift',
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: Color(0xFF334155)),
                  ),
                ),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: statusColor.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: statusColor.withValues(alpha: 0.4)),
                  ),
                  child: Text(
                    statusLabel,
                    style: TextStyle(color: statusColor, fontWeight: FontWeight.bold, fontSize: 10),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Row 2: Staff Name & Designation
            Row(
              children: [
                const Icon(Icons.person, size: 16, color: Color(0xFF64748B)),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '${user['fullName'] ?? 'Staff'} (${user['designation'] ?? 'Gateman'})',
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)),
                  ),
                ),
                Text(
                  r['dateFormatted'] ?? r['date'] ?? '',
                  style: TextStyle(fontSize: 11, color: Colors.grey.shade600, fontWeight: FontWeight.w500),
                ),
              ],
            ),
            const SizedBox(height: 6),

            // Row 3: Check-In Details
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.grey.shade50,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: Colors.grey.shade200),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(Icons.login_rounded, size: 14, color: Color(0xFF046A38)),
                            const SizedBox(width: 4),
                            Text('IN: ${checkIn?['timeFormatted'] ?? '-'}', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 11.5)),
                            if (isLate) ...[
                              const SizedBox(width: 6),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFDC2626).withValues(alpha: 0.1),
                                  borderRadius: BorderRadius.circular(3),
                                ),
                                child: Text('+$minutesLate min late', style: const TextStyle(fontSize: 9.5, fontWeight: FontWeight.bold, color: Color(0xFFDC2626))),
                              ),
                            ],
                          ],
                        ),
                        if (checkIn?['geofenceDistanceMeters'] != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              'Geofence: ${checkIn!['geofenceDistanceMeters']}m ${checkIn['isGeofenceVerified'] == true ? '✓ In Bounds' : '⚠ Out of Bounds'}',
                              style: TextStyle(fontSize: 10, color: checkIn['isGeofenceVerified'] == true ? const Color(0xFF046A38) : const Color(0xFFDC2626)),
                            ),
                          ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(Icons.logout_rounded, size: 14, color: Color(0xFF0284C7)),
                            const SizedBox(width: 4),
                            Text('OUT: ${checkOut?['timeFormatted'] ?? (status == 'ON_DUTY' ? 'Still On Duty' : '-')}', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 11.5)),
                          ],
                        ),
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            'Duty: ${r['totalDurationFormatted'] ?? '-'}',
                            style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── 7.2. ATTENDANCE EXCEPTION AUDIT VIEW ──
  Widget _buildAttendanceExceptionsView() {
    if (_isLoadingAttendanceExceptions) {
      return const Padding(
        padding: EdgeInsets.all(40),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(strokeWidth: 2.5, color: Color(0xFFDC2626)),
              SizedBox(height: 14),
              Text(
                'Auditing Shift Delays & Unstaffed Gate Deviations...',
                style: TextStyle(fontSize: 13, color: Color(0xFF64748B), fontWeight: FontWeight.w500),
              ),
            ],
          ),
        ),
      );
    }

    final metrics = (_attendanceExceptionsData?['metrics'] as Map<String, dynamic>?) ?? {};
    final rawExceptions = (_attendanceExceptionsData?['exceptions'] as List?) ?? [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 1. Safety Exception Header Card
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFDC2626).withValues(alpha: 0.3)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.02),
                blurRadius: 6,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: const Color(0xFFDC2626).withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Icon(Icons.warning_amber_rounded, color: Color(0xFFDC2626), size: 22),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Attendance Safety Audit & Exceptions',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14.5, color: Color(0xFF0F172A)),
                        ),
                        Text(
                          'Tracking shift delays, unstaffed gate hazards & perimeter violations',
                          style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              // KPI Strip
              Row(
                children: [
                  _buildAttendanceKpiBadge('Total Deviations', '${metrics['totalExceptions'] ?? 0}', const Color(0xFFDC2626)),
                  const SizedBox(width: 6),
                  _buildAttendanceKpiBadge('Delayed Shifts', '${metrics['lateArrivalsCount'] ?? 0}', const Color(0xFFD97706)),
                  const SizedBox(width: 6),
                  _buildAttendanceKpiBadge('Unstaffed Gates', '${metrics['unstaffedGateCount'] ?? 0}', const Color(0xFFB91C1C)),
                  const SizedBox(width: 6),
                  _buildAttendanceKpiBadge('Total Delay', metrics['totalDelayHoursFormatted'] ?? '0m', const Color(0xFF003580)),
                  const SizedBox(width: 6),
                  _buildAttendanceKpiBadge('Safety Score', '${metrics['safetyComplianceScore'] ?? 100}%', const Color(0xFF046A38)),
                ],
              ),
              const SizedBox(height: 12),
              // Export Actions
              Row(
                children: [
                  Expanded(
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF107C41),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        textStyle: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        elevation: 0,
                      ),
                      icon: const Icon(Icons.table_view_rounded, size: 16),
                      label: const Text('Export Audit Excel'),
                      onPressed: () {
                        _startExportWithProgress(
                          parentCtx: context,
                          selectedReportType: 'attendance_exception',
                          selectedFormat: 'xlsx',
                          selectedCols: {},
                        );
                      },
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFFE11D48),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        textStyle: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        elevation: 0,
                      ),
                      icon: const Icon(Icons.picture_as_pdf_rounded, size: 16),
                      label: const Text('Export Audit PDF'),
                      onPressed: () {
                        _startExportWithProgress(
                          parentCtx: context,
                          selectedReportType: 'attendance_exception',
                          selectedFormat: 'pdf',
                          selectedCols: {},
                        );
                      },
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),

        // Exceptions List
        if (rawExceptions.isEmpty)
          Container(
            padding: const EdgeInsets.all(32),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.grey.shade200),
            ),
            child: const Column(
              children: [
                Icon(Icons.verified, size: 38, color: Color(0xFF046A38)),
                SizedBox(height: 8),
                Text('Zero Safety Deviations Recorded', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF046A38))),
                SizedBox(height: 4),
                Text('All shifts commenced on schedule with full staff coverage.', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
              ],
            ),
          )
        else
          ...rawExceptions.map((exc) => _buildAttendanceExceptionCard(exc)),
      ],
    );
  }

  Widget _buildAttendanceExceptionCard(Map<String, dynamic> exc) {
    final severity = (exc['severity'] ?? 'LOW').toString().toUpperCase();
    final isCritical = severity == 'CRITICAL';
    final severityColor = isCritical ? const Color(0xFFDC2626) : const Color(0xFFD97706);

    final user = (exc['user'] as Map?);
    final gate = (exc['gate'] as Map?) ?? {};
    final shift = (exc['shift'] as Map?) ?? {};

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0.5,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: BorderSide(color: severityColor.withValues(alpha: 0.3)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Row 1: Severity tag + Gate + Date
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: severityColor,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    exc['severityLabel'] ?? severity,
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 10.5),
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: const Color(0xFF003580).withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    gate['lcNumber'] ?? 'LC Gate',
                    style: const TextStyle(color: Color(0xFF003580), fontWeight: FontWeight.bold, fontSize: 11),
                  ),
                ),
                const Spacer(),
                Text(
                  exc['dateFormatted'] ?? exc['date'] ?? '',
                  style: TextStyle(fontSize: 11, color: Colors.grey.shade600, fontWeight: FontWeight.w500),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Row 2: Delay duration highlight
            Row(
              children: [
                Icon(isCritical ? Icons.cancel : Icons.warning_amber_rounded, size: 16, color: severityColor),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    exc['delayFormatted'] ?? 'Shift Deviation',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: severityColor),
                  ),
                ),
                Text(
                  'Shift: ${shift['code'] ?? shift['name'] ?? '-'}',
                  style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Color(0xFF64748B)),
                ),
              ],
            ),
            const SizedBox(height: 6),

            // Row 3: Staff & Gate
            Text(
              user != null ? '${user['fullName']} (${user['designation'] ?? 'Gateman'})' : 'Staff: Unassigned / Absent',
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: Color(0xFF0F172A)),
            ),
            const SizedBox(height: 4),

            // Row 4: Incident Description
            Text(
              exc['description'] ?? '',
              style: const TextStyle(fontSize: 11.5, color: Color(0xFF334155)),
            ),
            const SizedBox(height: 6),

            // Row 5: Corrective Action Box
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                color: Colors.grey.shade50,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: Colors.grey.shade200),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.shield_outlined, size: 13, color: Color(0xFF003580)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      'Protocol: ${exc['correctiveAction'] ?? 'Recorded in audit log.'}',
                      style: const TextStyle(fontSize: 10.5, color: Color(0xFF475569), fontStyle: FontStyle.italic),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

}
