import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
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
  String get _userId => widget.user['id']?.toString() ?? '0';

  // 1. Report Type Switcher
  String _reportType = 'complete_log'; // 'complete_log' | 'cycle'
  Map<String, dynamic>? _cycleAnalytics;
  bool _isLoadingCycle = false;
  int? _selectedCycleGateId;

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
    {'key': 'scopeGroup', 'label': 'Cluster / Scope Group'},
    {'key': 'lcNumber', 'label': 'LC Number'},
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
    _isDeveloper = widget.user['role'] == 'Developer';
    final now = DateTime.now();
    _dateRange = DateTimeRange(
      start: now.subtract(const Duration(days: 7)),
      end: now,
    );
    _loadTokenAndFetch();
    _startPollingTimer();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pollingTimer?.cancel();
    _searchCtrl.dispose();
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
    });
    if (_reportType == 'cycle') {
      _fetchCycleAnalytics();
    } else {
      _fetchRecords();
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
          if (_reportType == 'cycle') {
            _fetchCycleAnalytics();
          } else {
            _fetchRecords();
          }
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
          });
          if (_reportType == 'cycle') {
            _fetchCycleAnalytics();
          } else {
            _fetchRecords(forceReload: true);
          }
        }
        return;
      } else if (res.statusCode == 403 && mounted) {
        AppFeedback.showError(context, 'No clusters are assigned to your user account.');
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
        if (_reportType == 'cycle') {
          _fetchCycleAnalytics();
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
                          const Text('Scope Groups & Gates', style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: AppColors.primary)),
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
                                    cluster['name'] ?? 'Cluster',
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
                              setState(() {});
                              if (_reportType == 'cycle') {
                                _fetchCycleAnalytics();
                              } else {
                                _fetchRecords();
                              }
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
                    selectedReportType == 'cycle' ? 'Compiling operating cycle analytics...' : 'Compiling operational logs & metrics...',
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
      if (_selectedGateIds.isNotEmpty) queryParams['gateIds'] = _selectedGateIds.join(',');
      if (_filterStatus != 'ALL') queryParams['status'] = _filterStatus;
      if (_filterShift != 'ALL') queryParams['shift'] = _filterShift;

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
          final ext = selectedFormat == 'pdf' ? 'pdf' : 'xlsx';
          final mimeType = selectedFormat == 'pdf'
              ? 'application/pdf'
              : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          final timestamp = DateTime.now().millisecondsSinceEpoch;
          final filename = selectedReportType == 'cycle'
              ? 'LC_Gate_Cycle_Report_$timestamp.$ext'
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
                                  onTap: () => setModalState(() => selectedReportType = 'complete_log'),
                                  child: Container(
                                    padding: const EdgeInsets.all(12),
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
                                        Icon(Icons.format_list_bulleted_rounded, color: AppColors.primary, size: 24),
                                        SizedBox(height: 6),
                                        Text('Complete Log', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                                        Text('Chronological logs', style: TextStyle(fontSize: 10.5, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedReportType = 'cycle'),
                                  child: Container(
                                    padding: const EdgeInsets.all(12),
                                    decoration: BoxDecoration(
                                      color: selectedReportType == 'cycle' ? const Color(0xFF046A38).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: selectedReportType == 'cycle' ? const Color(0xFF046A38) : Colors.grey.shade300,
                                        width: 2,
                                      ),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.insights_rounded, color: Color(0xFF046A38), size: 24),
                                        SizedBox(height: 6),
                                        Text('Cycle Report', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                                        Text('Operating cycles audit', style: TextStyle(fontSize: 10.5, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
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
                                Text('Selected: ${_selectedClusterIds.length} Clusters, ${_selectedGateIds.length} Gates', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
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
                                    padding: const EdgeInsets.all(12),
                                    decoration: BoxDecoration(
                                      color: selectedFormat == 'xlsx' ? const Color(0xFF107C41).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(color: selectedFormat == 'xlsx' ? const Color(0xFF107C41) : Colors.grey.shade300, width: 2),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.table_view_rounded, color: Color(0xFF107C41), size: 28),
                                        SizedBox(height: 6),
                                        Text('Excel (.xlsx)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5)),
                                        Text('Formatted sheet', style: TextStyle(fontSize: 10.5, color: Colors.grey)),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: InkWell(
                                  onTap: () => setModalState(() => selectedFormat = 'pdf'),
                                  child: Container(
                                    padding: const EdgeInsets.all(12),
                                    decoration: BoxDecoration(
                                      color: selectedFormat == 'pdf' ? const Color(0xFFE11D48).withValues(alpha: 0.08) : Colors.white,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(color: selectedFormat == 'pdf' ? const Color(0xFFE11D48) : Colors.grey.shade300, width: 2),
                                    ),
                                    child: Column(
                                      children: const [
                                        Icon(Icons.picture_as_pdf_rounded, color: Color(0xFFE11D48), size: 28),
                                        SizedBox(height: 6),
                                        Text('PDF Document', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5)),
                                        Text('Printable logsheet', style: TextStyle(fontSize: 10.5, color: Colors.grey)),
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
                                    if (_selectedGateIds.isEmpty) {
                                      AppFeedback.showInfo(context, 'Please select at least one gate to export.');
                                      return;
                                    }
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
            onPressed: () => _reportType == 'cycle' ? _fetchCycleAnalytics() : _fetchRecords(forceReload: true),
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
              onRefresh: () => _reportType == 'cycle' ? _fetchCycleAnalytics() : _fetchRecords(forceReload: true),
              child: ListView(
                padding: const EdgeInsets.all(12),
                children: [
                  // 1. Report Type Selector
                  _buildReportTypeSelector(),

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
                                const Text('Clusters & Gates Selection', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5)),
                                Text('${_selectedClusterIds.length} Clusters • ${_selectedGateIds.length} Gates Selected', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
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
                                  });
                                  if (_reportType == 'cycle') {
                                    _fetchCycleAnalytics();
                                  } else {
                                    _fetchRecords();
                                  }
                                }
                              },
                              child: Row(
                                children: const [
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
                  ] else ...[
                    _buildCycleAnalyticsView(),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _buildReportTypeSelector() {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Row(
        children: [
          Expanded(
            child: InkWell(
              onTap: () {
                if (_reportType != 'complete_log') {
                  setState(() => _reportType = 'complete_log');
                  if (_records.isEmpty) {
                    _fetchRecords();
                  }
                }
              },
              borderRadius: BorderRadius.circular(8),
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 9),
                decoration: BoxDecoration(
                  color: _reportType == 'complete_log' ? AppColors.primary : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.format_list_bulleted_rounded,
                      size: 16,
                      color: _reportType == 'complete_log' ? Colors.white : Colors.grey.shade700,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'Complete Log',
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.bold,
                        color: _reportType == 'complete_log' ? Colors.white : Colors.grey.shade700,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(width: 4),
          Expanded(
            child: InkWell(
              onTap: () {
                if (_reportType != 'cycle') {
                  setState(() => _reportType = 'cycle');
                  _fetchCycleAnalytics();
                }
              },
              borderRadius: BorderRadius.circular(8),
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 9),
                decoration: BoxDecoration(
                  color: _reportType == 'cycle' ? const Color(0xFF046A38) : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.insights_rounded,
                      size: 16,
                      color: _reportType == 'cycle' ? Colors.white : Colors.grey.shade700,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'Cycle Report',
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.bold,
                        color: _reportType == 'cycle' ? Colors.white : Colors.grey.shade700,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
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
                  'Try selecting more clusters/gates or widening the date range.',
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
      String dateKey = (rec['openedDate'] ?? '').toString();
      if (dateKey.isEmpty && rec['openedAt'] != null) {
        dateKey = rec['openedAt'].toString().split('T').first;
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
            Text('Tap refresh or select clusters to calculate cycle KPIs.', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
          ],
        ),
      );
    }

    final overall = (_cycleAnalytics!['overall'] as Map<String, dynamic>?) ?? {};
    final gateReports = (_cycleAnalytics!['gateReports'] as List?) ?? [];

    final totalCycles = overall['totalCycles'] ?? 0;
    final avgClosingFormatted = overall['avgClosingFormatted'] ?? '—';
    final avgOpeningFormatted = overall['avgOpeningFormatted'] ?? '—';
    final totalClosedFormatted = overall['totalClosedFormatted'] ?? '0s';
    final totalOpenFormatted = overall['totalOpenFormatted'] ?? '0s';
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
                'Avg Closing Time',
                '$avgClosingFormatted',
                Icons.hourglass_bottom_rounded,
                const Color(0xFF2563EB),
                'Mean closure duration',
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: _buildCycleKpiCard(
                'Avg Opening Time',
                '$avgOpeningFormatted',
                Icons.schedule_rounded,
                const Color(0xFF059669),
                'Road clearance interval',
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _buildCycleKpiCard(
                'Total Road Closed',
                '$totalClosedFormatted',
                Icons.timer_outlined,
                const Color(0xFFD97706),
                'Cumulative restriction',
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: _buildCycleKpiCard(
                'Total Road Open',
                '$totalOpenFormatted',
                Icons.speed_rounded,
                const Color(0xFF7C3AED),
                'Cumulative clearance',
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
                          Text(gate['lcNumber'] ?? 'LC', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF046A38))),
                          if (gate['name'] != null && gate['name'].toString().isNotEmpty) ...[
                            const SizedBox(width: 6),
                            Text('• ${gate['name']}', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${gate['locationName'] ?? ''}${gate['division'] != null ? ' • ${gate['division']} Div' : ''}${gate['zone'] != null ? ' (${gate['zone']})' : ''}',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
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
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(d['dateFormatted'] ?? d['dateStr'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12)),
                          const SizedBox(height: 2),
                          Text(
                            'Closed: ${d['totalClosedFormatted'] ?? '0s'} • Open: ${d['totalOpenFormatted'] ?? '0s'}',
                            style: TextStyle(fontSize: 10.5, color: Colors.grey.shade600),
                          ),
                        ],
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
                            'Avg close: ${d['avgClosingFormatted'] ?? '—'}',
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

    final openedAtStr = rec['openedAt'] != null ? rec['openedAt'].toString().split('T').last.split('.').first : '-';
    final closedAtStr = rec['closedAt'] != null ? rec['closedAt'].toString().split('T').last.split('.').first : 'OPEN';

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
              Text(rec['lcNumber'] ?? 'LC', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5, color: AppColors.primary)),
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
    final currentlyOpen = _metrics['currentlyOpenCount'] ?? 0;
    final reportingGates = _metrics['reportingGatesCount'] ?? 0;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(child: _buildKpiCard('Total Ops', '$totalOps', Icons.alt_route_rounded, const Color(0xFF3B82F6))),
              const SizedBox(width: 8),
              Expanded(child: _buildKpiCard('Total Duration', '$totalDuration', Icons.timer_outlined, const Color(0xFF8B5CF6))),
              const SizedBox(width: 8),
              Expanded(child: _buildKpiCard('Avg Duration', '$avgDuration', Icons.speed_rounded, const Color(0xFF06B6D4))),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(child: _buildKpiCard('Delays (>15m)', '$extendedDelays', Icons.warning_amber_rounded, const Color(0xFFF59E0B))),
              const SizedBox(width: 8),
              Expanded(child: _buildKpiCard('Currently Open', '$currentlyOpen', Icons.lock_open_rounded, const Color(0xFFEF4444))),
              const SizedBox(width: 8),
              Expanded(child: _buildKpiCard('Active Gates', '$reportingGates', Icons.grid_view_rounded, const Color(0xFF10B981))),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildKpiCard(String label, String value, IconData icon, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
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
                child: Text(
                  label,
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: Colors.grey.shade600),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Icon(icon, size: 13, color: color),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            value,
            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: color),
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}
