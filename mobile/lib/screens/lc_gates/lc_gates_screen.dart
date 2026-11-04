import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'dart:convert';
import 'dart:async';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import '../../services/lc_gates_cache_service.dart';

class LCGatesScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  final int? initialGateId;
  final String? initialTab;

  const LCGatesScreen({
    super.key,
    required this.user,
    this.initialGateId,
    this.initialTab,
  });

  @override
  State<LCGatesScreen> createState() => _LCGatesScreenState();
}

class _LCGatesScreenState extends State<LCGatesScreen> {
  bool _isLoading = true;
  bool _isRefreshing = false;
  String _token = '';
  String _userId = 'user';

  // Breadcrumbs: List of {id: int?, name: String, color: String?}
  final List<Map<String, dynamic>> _breadcrumbs = [
    {'id': null, 'name': 'LC Gate', 'color': null}
  ];

  int? get _currentFolderId => _breadcrumbs.last['id'] as int?;

  // View Mode: 'folder' | 'detail'
  String _viewMode = 'folder';

  // Selected Cluster for Full Drilldown
  Map<String, dynamic>? _selectedGate;

  // Drilldown Active Tab: 'about' | 'telemetry'
  String _clusterTab = 'about';

  String getFullImageUrl(String? url) {
    if (url == null || url.isEmpty) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    final base = baseUrl;
    final host = base.endsWith('/api/v1')
        ? base.substring(0, base.length - '/api/v1'.length)
        : base;
    return '$host$url';
  }

  Color parseHexColor(dynamic hexStr, {Color fallback = AppColors.primary}) {
    if (hexStr == null) return fallback;
    final s = hexStr.toString().replaceAll('#', '').trim();
    if (s.length == 6) {
      final val = int.tryParse('FF$s', radix: 16);
      if (val != null) return Color(val);
    } else if (s.length == 8) {
      final val = int.tryParse(s, radix: 16);
      if (val != null) return Color(val);
    }
    return fallback;
  }

  // Search Filter
  final _searchCtrl = TextEditingController();
  String _searchQuery = '';

  // Telemetry & Inspector State
  Map<String, dynamic>? _gateTelemetry;
  bool _loadingTelemetry = false;
  WebSocketChannel? _telemetryWsChannel;
  StreamSubscription? _telemetryWsSub;
  Timer? _wsReconnectTimer;

  // Manage expandable/collapsible state for multiple devices
  int? _expandedMasterIndex = 0;
  int? _expandedSlaveId;

  // Data
  List<dynamic> _scopeGroups = [];
  List<dynamic> _gates = [];
  bool _isOutdated = false;
  Timer? _statusSyncTimer;

  @override
  void initState() {
    super.initState();
    _loadTokenAndFetch();
    _startPeriodicStatusSync();
  }

  @override
  void dispose() {
    _statusSyncTimer?.cancel();
    _statusSyncTimer = null;
    _disconnectTelemetryWs();
    _searchCtrl.dispose();
    super.dispose();
  }

  void _startPeriodicStatusSync() {
    _statusSyncTimer?.cancel();
    // 45-second periodic device status synchronization timer while directory is active
    _statusSyncTimer = Timer.periodic(const Duration(seconds: 45), (_) {
      _syncStatusSilently();
    });
  }

  Future<void> _syncStatusSilently() async {
    if (!mounted || _token.isEmpty) return;
    try {
      final statuses = await LCGatesCacheService.instance.syncStatusSummary(token: _token, forceReload: true);
      if (mounted && statuses.isNotEmpty) {
        setState(() {
          _applyDynamicStatuses(statuses);
        });
      }
    } catch (e) {
      debugPrint('[LCGates] Silent status sync error: $e');
    }
  }

  Future<void> _loadTokenAndFetch() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token') ?? '';
    final userId = (widget.user['id'] ?? prefs.getString('userId') ?? prefs.getString('employeeId') ?? 'user').toString();
    if (!mounted) return;
    setState(() {
      _token = token;
      _userId = userId;
    });

    // 1. Instant Cache-First Synchronous / Disk Read: ZERO SPINNER on revisit!
    final cached = LCGatesCacheService.instance.getMemoryCachedDirectory(userId) ??
        await LCGatesCacheService.instance.getCachedDirectory(userId);

    if (cached != null && cached.gates.isNotEmpty) {
      if (mounted) {
        setState(() {
          _gates = List.from(cached.gates);
          _scopeGroups = List.from(cached.scopeGroups);
          _isOutdated = cached.isOutdated;
          _isLoading = false;
          _checkInitialGateSelection();
        });
      }
    }

    // 2. Silent Background Revalidation (SWR) with safe HTTP 304 handling and TTL
    await _fetchData(isManual: false);
  }

  void _checkInitialGateSelection() {
    if (widget.initialGateId != null && _selectedGate == null) {
      final found = _gates.firstWhere(
        (g) => g is Map && g['id'] == widget.initialGateId,
        orElse: () => null,
      );
      if (found != null) {
        _selectedGate = Map<String, dynamic>.from(found);
        _viewMode = 'detail';
        _clusterTab = widget.initialTab ?? 'about';
      }
    }
  }

  void _applyDynamicStatuses(Map<int, GateStatusItem> statuses) {
    for (int i = 0; i < _gates.length; i++) {
      final g = _gates[i];
      if (g is Map && g.containsKey('id')) {
        final statusItem = statuses[g['id']];
        if (statusItem != null) {
          _gates[i] = <String, dynamic>{
            ...Map<String, dynamic>.from(g),
            'isOnline': statusItem.isOnline,
            'deviceStatus': statusItem.deviceStatus,
            'lastSeenAt': statusItem.lastSeenAt,
          };
        }
      }
    }
  }

  Future<void> _fetchData({bool isManual = false}) async {
    if (isManual) {
      setState(() => _isRefreshing = true);
    } else if (_gates.isEmpty) {
      setState(() => _isLoading = true);
    }

    try {
      // 1. Parallel Directory SWR Sync (ETag / 304 handled)
      final syncResult = await LCGatesCacheService.instance.syncDirectory(
        userId: _userId,
        token: _token,
        forceReload: isManual,
      );

      if (mounted && syncResult.data != null) {
        setState(() {
          _gates = List.from(syncResult.data!.gates);
          _scopeGroups = List.from(syncResult.data!.scopeGroups);
          _isOutdated = syncResult.isOutdated;
          _isLoading = false;
          _isRefreshing = false;
          _checkInitialGateSelection();
        });
      } else if (mounted) {
        setState(() {
          _isOutdated = syncResult.isOutdated;
        });
      }

      // 2. Independent Dynamic Device Status Synchronization
      final statuses = await LCGatesCacheService.instance.syncStatusSummary(
        token: _token,
        forceReload: isManual,
      );
      if (mounted && statuses.isNotEmpty) {
        setState(() {
          _applyDynamicStatuses(statuses);
        });
      }

      if (mounted && isManual) {
        AppFeedback.showSuccess(context, 'LC Gates directory refreshed.');
      }
    } catch (e) {
      debugPrint('[LCGates] Data fetch error: $e');
      if (mounted && isManual) {
        AppFeedback.showError(context, 'Failed to refresh directory: $e');
      }
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
          _isRefreshing = false;
        });
      }
    }
  }

  // Current Folders Filtered
  List<dynamic> get _currentFolders {
    final curId = _currentFolderId;
    var result = _scopeGroups.where((g) {
      if (g is! Map) return false;
      if (curId == null) {
        return g['parentId'] == null || g['parent'] == null;
      }
      return g['parentId'] == curId;
    }).toList();

    if (_searchQuery.trim().isNotEmpty) {
      final q = _searchQuery.toLowerCase().trim();
      result = result.where((g) {
        final name = (g['name'] ?? '').toString().toLowerCase();
        final desc = (g['description'] ?? '').toString().toLowerCase();
        return name.contains(q) || desc.contains(q);
      }).toList();
    }
    return result;
  }

  // Current Clusters Filtered
  List<dynamic> get _currentClusters {
    final curId = _currentFolderId;
    var result = _gates.where((g) {
      if (g is! Map) return false;
      final sgs = g['scopeGroups'] as List?;
      if (curId == null) {
        return sgs == null || sgs.isEmpty;
      }
      if (sgs == null) return false;
      return sgs.any((item) {
        final gid = item['scopeGroupId'] ?? item['scopeGroup']?['id'];
        return gid == curId;
      });
    }).toList();

    if (_searchQuery.trim().isNotEmpty) {
      final q = _searchQuery.toLowerCase().trim();
      result = result.where((g) {
        final lc = (g['lcNumber'] ?? '').toString().toLowerCase();
        final name = (g['name'] ?? '').toString().toLowerCase();
        final loc = (g['locationName'] ?? '').toString().toLowerCase();
        final zone = (g['zone'] ?? '').toString().toLowerCase();
        final div = (g['division'] ?? '').toString().toLowerCase();
        return lc.contains(q) || name.contains(q) || loc.contains(q) || zone.contains(q) || div.contains(q);
      }).toList();
    }
    return result;
  }

  // Helper to extract uploaded evidence photo matching component type
  Map<String, dynamic>? _findDeviceEvidence(
    Map<String, dynamic> master,
    String category, [
    int? childDeviceId,
    String? childType,
  ]) {
    final mEvs = (master['evidences'] as List?) ?? [];
    for (final e in mEvs) {
      if (e is Map<String, dynamic>) {
        if (childDeviceId != null && e['childDeviceId'] == childDeviceId) return e;
        if (e['category'] == category) {
          if (childDeviceId == null || e['childDeviceId'] == childDeviceId) return e;
        }
        if (childType != null && e['category'] == childType) return e;
      }
    }
    if (childDeviceId != null) {
      final children = (master['childDevices'] as List?) ?? [];
      for (final c in children) {
        if (c is Map && c['id'] == childDeviceId) {
          final cEvs = (c['evidences'] as List?) ?? [];
          if (cEvs.isNotEmpty && cEvs.first is Map) {
            return Map<String, dynamic>.from(cEvs.first as Map);
          }
        }
      }
    }
    return null;
  }

  // Compute operational gate status: 'OPEN' or 'CLOSED'
  String _getGateStatus(Map<String, dynamic> gate) {
    final events = gate['events'] as List?;
    if (events != null && events.isNotEmpty) {
      final firstEv = events.first;
      if (firstEv is Map) {
        final ev = Map<String, dynamic>.from(firstEv);
        final st = (ev['status'] ?? '').toString().toUpperCase();
        if (st == 'OPEN' || ev['closedAt'] == null) return 'OPEN';
        if (st == 'CLOSED' || ev['closedAt'] != null) return 'CLOSED';
      }
    }
    final devs = gate['deviceRegistries'] as List?;
    if (devs != null && devs.isNotEmpty) {
      for (final d in devs) {
        if (d is Map) {
          final st = (d['status'] ?? '').toString().toUpperCase();
          if (st == 'OPEN' || st == 'NOT_CLOSED') return 'OPEN';
          if (st == 'CLOSED') return 'CLOSED';
        }
      }
    }
    final rawStatus = (gate['currentStatus'] ?? gate['status'] ?? '').toString().toUpperCase();
    if (rawStatus == 'OPEN') return 'OPEN';
    return 'CLOSED';
  }

  // Jump Breadcrumb
  void _jumpBreadcrumb(int index) {
    setState(() {
      _breadcrumbs.removeRange(index + 1, _breadcrumbs.length);
      _viewMode = 'folder';
      _selectedGate = null;
    });
  }

  // Open Folder
  void _openFolder(Map<String, dynamic> group) {
    setState(() {
      _breadcrumbs.add({
        'id': group['id'],
        'name': group['name'] ?? 'Scope Group',
        'color': group['color'],
      });
    });
  }

  // Open Drilldown
  void _openClusterDetail(Map<String, dynamic> gate, String tab) {
    setState(() {
      _selectedGate = gate;
      _clusterTab = tab;
      _viewMode = 'detail';
      _expandedMasterIndex = 0;
      _expandedSlaveId = null;
    });
    final gateId = gate['id'];
    final idNum = gateId is int ? gateId : int.tryParse(gateId?.toString() ?? '') ?? 0;
    if (tab == 'telemetry') {
      if (idNum > 0) {
        _connectTelemetryWs(idNum);
      }
    } else {
      _disconnectTelemetryWs();
    }
  }

  // Evidence Photo Full View Dialog
  void _showEvidenceDialog({
    required Map<String, dynamic> gate,
    required Map<String, dynamic> evidence,
    String? itemTitle,
    int? masterSeq,
    int? deviceSeq,
  }) {
    showDialog(
      context: context,
      builder: (ctx) {
        final imgUrl = getFullImageUrl(evidence['imageUrl']?.toString());
        final lat = evidence['latitude'];
        final lng = evidence['longitude'];
        final createdAt = evidence['createdAt']?.toString();

        return Dialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          backgroundColor: Colors.white,
          clipBehavior: Clip.antiAlias,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  decoration: const BoxDecoration(
                    color: Color(0xFFF8FAFC),
                    border: Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.camera_alt_outlined, color: AppColors.primary, size: 20),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          itemTitle ?? 'Installation Evidence Photo',
                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.close, size: 20, color: Color(0xFF64748B)),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(),
                        onPressed: () => Navigator.pop(ctx),
                      ),
                    ],
                  ),
                ),
                Container(
                  color: const Color(0xFF0F172A),
                  constraints: const BoxConstraints(maxHeight: 340),
                  child: imgUrl.isNotEmpty
                      ? InteractiveViewer(
                          child: Image.network(
                            imgUrl,
                            fit: BoxFit.contain,
                            loadingBuilder: (context, child, progress) {
                              if (progress == null) return child;
                              return const Center(
                                child: Padding(
                                  padding: EdgeInsets.all(40),
                                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                ),
                              );
                            },
                            errorBuilder: (context, error, stackTrace) => const Padding(
                              padding: EdgeInsets.all(40),
                              child: Center(
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(Icons.broken_image_outlined, color: Colors.white70, size: 40),
                                    SizedBox(height: 8),
                                    Text('Unable to load photo', style: TextStyle(color: Colors.white70, fontSize: 12)),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        )
                      : const Padding(
                          padding: EdgeInsets.all(40),
                          child: Center(
                            child: Text('No photo URL specified', style: TextStyle(color: Colors.white70)),
                          ),
                        ),
                ),
                Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            'Gate: ${gate['lcNumber'] ?? 'LC-GATE'}',
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)),
                          ),
                          Text(
                            'Master #${masterSeq ?? 1}${deviceSeq != null ? ' • Slave #$deviceSeq' : ''}',
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: AppColors.primary),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      if (lat != null && lng != null) ...[
                        Row(
                          children: [
                            const Icon(Icons.location_on, size: 14, color: Color(0xFFEF4444)),
                            const SizedBox(width: 4),
                            Text(
                              'GPS Coordinates: ${(lat as num).toStringAsFixed(5)}, ${(lng as num).toStringAsFixed(5)}',
                              style: const TextStyle(fontSize: 12, color: Color(0xFF475569), fontWeight: FontWeight.w600),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                      ],
                      if (createdAt != null) ...[
                        Row(
                          children: [
                            const Icon(Icons.access_time, size: 14, color: Color(0xFF64748B)),
                            const SizedBox(width: 4),
                            Text(
                              'Captured: ${_formatDateTime(createdAt)}',
                              style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                            ),
                          ],
                        ),
                      ],
                      const SizedBox(height: 12),
                      ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppColors.primary,
                          minimumSize: const Size.fromHeight(38),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                        onPressed: () => Navigator.pop(ctx),
                        child: const Text('Close Viewer', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  // Telemetry WebSocket Connection
  void _connectTelemetryWs(int gateId) {
    _disconnectTelemetryWs();
    _fetchGateTelemetry(gateId, silent: false);

    try {
      final wsUrlStr = baseUrl
          .replaceFirst('http://', 'ws://')
          .replaceFirst('https://', 'wss://')
          .replaceFirst('/api/v1', '/ws/telemetry?gateId=$gateId');

      final uri = Uri.parse(wsUrlStr);
      _telemetryWsChannel = WebSocketChannel.connect(uri);
      _telemetryWsChannel?.ready.catchError((_) {});

      _telemetryWsSub = _telemetryWsChannel!.stream.listen(
        (message) {
          try {
            final data = json.decode(message.toString());
            if (data is Map<String, dynamic> && mounted) {
              setState(() {
                _gateTelemetry = data;
              });
            }
          } catch (_) {}
        },
        onDone: () {
          _scheduleWsReconnect(gateId);
        },
        onError: (err) {
          _scheduleWsReconnect(gateId);
        },
      );

    } catch (_) {
      _scheduleWsReconnect(gateId);
    }
  }

  void _disconnectTelemetryWs() {
    _wsReconnectTimer?.cancel();
    _wsReconnectTimer = null;
    _telemetryWsSub?.cancel();
    _telemetryWsSub = null;
    try {
      _telemetryWsChannel?.sink.close();
    } catch (_) {}
    _telemetryWsChannel = null;
  }

  void _scheduleWsReconnect(int gateId) {
    _wsReconnectTimer?.cancel();
    if (_viewMode == 'detail' && _clusterTab == 'telemetry' && _selectedGate != null) {
      _wsReconnectTimer = Timer(const Duration(seconds: 4), () {
        if (mounted && _viewMode == 'detail' && _clusterTab == 'telemetry') {
          _connectTelemetryWs(gateId);
        }
      });
    }
  }

  Future<void> _fetchGateTelemetry(int gateId, {bool silent = false}) async {
    if (gateId <= 0) return;
    if (!silent) {
      setState(() => _loadingTelemetry = true);
    }
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/$gateId/telemetry'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $_token',
        },
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted && data is Map<String, dynamic>) {
          setState(() {
            _gateTelemetry = data;
            _loadingTelemetry = false;
          });
        }
      } else {
        if (mounted) setState(() => _loadingTelemetry = false);
      }
    } catch (_) {
      if (mounted) setState(() => _loadingTelemetry = false);
    }
  }

  // Parse any timestamp format reliably
  DateTime? _parseTimestamp(dynamic val) {
    if (val == null) return null;
    if (val is DateTime) return val.toLocal();
    if (val is int) return DateTime.fromMillisecondsSinceEpoch(val).toLocal();
    final s = val.toString().trim();
    final intVal = int.tryParse(s);
    if (intVal != null && s.length >= 10) {
      if (s.length == 10) return DateTime.fromMillisecondsSinceEpoch(intVal * 1000).toLocal();
      return DateTime.fromMillisecondsSinceEpoch(intVal).toLocal();
    }
    try {
      return DateTime.parse(s).toLocal();
    } catch (_) {
      return null;
    }
  }

  String _formatDateTime(dynamic dtStr) {
    final dt = _parseTimestamp(dtStr);
    if (dt == null) return '—';
    final h = dt.hour % 12 == 0 ? 12 : dt.hour % 12;
    final m = dt.minute.toString().padLeft(2, '0');
    final s = dt.second.toString().padLeft(2, '0');
    final ampm = dt.hour >= 12 ? 'PM' : 'AM';
    final mo = dt.month.toString().padLeft(2, '0');
    final day = dt.day.toString().padLeft(2, '0');
    final yr = dt.year;
    return '$h:$m:$s $ampm • $mo/$day/$yr';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      body: (_isLoading && _gates.isEmpty)
          ? const Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CircularProgressIndicator(color: AppColors.primary),
                  SizedBox(height: 16),
                  Text('Loading LC Gates directory...', style: TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF1E293B))),
                ],
              ),
            )
          : RefreshIndicator(
              onRefresh: () => _fetchData(isManual: true),
              color: AppColors.primary,
              child: SingleChildScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_isOutdated)
                      Container(
                        margin: const EdgeInsets.only(bottom: 10),
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFFBEB),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFFDE68A)),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.cloud_off, size: 16, color: Color(0xFFD97706)),
                            const SizedBox(width: 8),
                            const Expanded(
                              child: Text(
                                'Showing cached directory (offline or reconnecting...)',
                                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF92400E)),
                              ),
                            ),
                            GestureDetector(
                              onTap: () => _fetchData(isManual: true),
                              child: const Text('Retry', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFFB45309))),
                            ),
                          ],
                        ),
                      ),

                    // 1. Navigation Toolbar (Breadcrumb + Search + Refresh)
                    _buildNavigationToolbar(),
                    const SizedBox(height: 14),

                    // 2. Main Views (Detail drilldown or Minimalist Directory)
                    if (_viewMode == 'detail' && _selectedGate != null)
                      _buildDetailView()
                    else
                      _buildDirectoryView(),
                  ],
                ),
              ),
            ),
    );
  }

  // ==========================================================
  // NAVIGATION & TOOLBAR (Minimalist Breadcrumbs & Integrated Search)
  // ==========================================================
  Widget _buildNavigationToolbar() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: const [
          BoxShadow(color: Color(0x06000000), offset: Offset(0, 1), blurRadius: 2),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Breadcrumbs Bar
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (int i = 0; i < _breadcrumbs.length; i++) ...[
                  InkWell(
                    onTap: () => _jumpBreadcrumb(i),
                    borderRadius: BorderRadius.circular(6),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: (i == _breadcrumbs.length - 1 && _viewMode != 'detail')
                            ? const Color(0xFFEFF6FF)
                            : const Color(0xFFF1F5F9),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(
                          color: (i == _breadcrumbs.length - 1 && _viewMode != 'detail')
                              ? const Color(0xFFBFDBFE)
                              : Colors.transparent,
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (i == 0) ...[
                            const Icon(Icons.home_outlined, size: 13, color: AppColors.primary),
                            const SizedBox(width: 5),
                          ],
                          Text(
                            _breadcrumbs[i]['name'] ?? 'Folder',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              color: (i == _breadcrumbs.length - 1 && _viewMode != 'detail')
                                  ? const Color(0xFF1D4ED8)
                                  : const Color(0xFF0F172A),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (i < _breadcrumbs.length - 1 || _viewMode == 'detail')
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 4),
                      child: Text('/', style: TextStyle(color: Color(0xFF94A3B8), fontSize: 13)),
                    ),
                ],
                if (_viewMode == 'detail' && _selectedGate != null)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFFEFF6FF),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: const Color(0xFFBFDBFE)),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.meeting_room_outlined, size: 13, color: Color(0xFF1D4ED8)),
                        const SizedBox(width: 5),
                        Text(
                          _selectedGate!['lcNumber'] ?? 'Gate',
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8)),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          if (_viewMode != 'detail') ...[
            const SizedBox(height: 10),

            // Search Field with Integrated Refresh Button (Only shown in directory list view)
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _searchCtrl,
                    onChanged: (val) => setState(() => _searchQuery = val),
                    style: const TextStyle(fontSize: 13),
                    decoration: InputDecoration(
                      hintText: 'Search gates...',
                      hintStyle: TextStyle(color: Colors.grey.shade400, fontSize: 13),
                      prefixIcon: const Icon(Icons.search, size: 18, color: Color(0xFF64748B)),
                      suffixIcon: _searchQuery.isNotEmpty
                          ? IconButton(
                              icon: const Icon(Icons.clear, size: 16),
                              onPressed: () {
                                _searchCtrl.clear();
                                setState(() => _searchQuery = '');
                              },
                            )
                          : null,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      isDense: true,
                      filled: true,
                      fillColor: const Color(0xFFF8FAFC),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFFE2E8F0))),
                      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFFE2E8F0))),
                      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: AppColors.primary)),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  style: IconButton.styleFrom(
                    backgroundColor: const Color(0xFFF1F5F9),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    padding: const EdgeInsets.all(9),
                  ),
                  icon: _isRefreshing
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary))
                      : const Icon(Icons.refresh, size: 18, color: Color(0xFF475569)),
                  tooltip: 'Refresh directory',
                  onPressed: _isRefreshing ? null : () => _fetchData(isManual: true),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  // ==========================================================
  // DIRECTORY VIEW: MINIMALIST GOOGLE DRIVE FOLDERS + CLUSTERS
  // ==========================================================
  Widget _buildDirectoryView() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 1. Scope / Region Cards (Minimalistic, no internal jargon headings)
        if (_currentFolders.isNotEmpty) ...[
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: _currentFolders.length,
            separatorBuilder: (context, index) => const SizedBox(height: 8),
            itemBuilder: (context, index) {
              final raw = _currentFolders[index];
              if (raw is! Map) return const SizedBox.shrink();
              final folder = Map<String, dynamic>.from(raw);
              return _buildScopeGroupCard(folder);
            },
          ),
          const SizedBox(height: 14),
        ],

        // 2. Clusters Section (Render only if clusters exist or inside a scope group)
        if (_currentClusters.isNotEmpty || _currentFolderId != null) ...[
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 8),
            child: Row(
              children: [
                const Icon(Icons.meeting_room_outlined, size: 16, color: AppColors.primary),
                const SizedBox(width: 6),
                Text(
                  _currentFolderId == null
                      ? 'Gates'
                      : 'Gates in ${_breadcrumbs.last['name']}',
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
                ),
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: const Color(0xFFE2E8F0),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    '${_currentClusters.length}',
                    style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF334155)),
                  ),
                ),
              ],
            ),
          ),
          if (_currentClusters.isEmpty)
            _buildEmptyCard(
              icon: Icons.meeting_room_outlined,
              title: 'No Gates Found',
              message: 'No gates are currently configured in this section.',
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: _currentClusters.length,
              separatorBuilder: (context, index) => const SizedBox(height: 12),
              itemBuilder: (context, index) {
                final raw = _currentClusters[index];
                if (raw is! Map) return const SizedBox.shrink();
                final gate = Map<String, dynamic>.from(raw);
                return _buildClusterCard(gate);
              },
            ),
        ],
      ],
    );
  }

  // Scope Group Card (Larger, spacious card without folder icons)
  Widget _buildScopeGroupCard(Map<String, dynamic> folder) {
    final groupColor = parseHexColor(folder['color'], fallback: AppColors.primary);
    final groupName = folder['name']?.toString() ?? 'Scope Group';

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () => _openFolder(folder),
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFE2E8F0)),
            boxShadow: const [
              BoxShadow(color: Color(0x05000000), offset: Offset(0, 1), blurRadius: 3),
            ],
          ),
          child: Row(
            children: [
              // Left Accent Color Bar
              Container(
                width: 4,
                height: 38,
                decoration: BoxDecoration(
                  color: groupColor,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  groupName,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF0F172A),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: const Color(0xFFF1F5F9),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Explore',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF475569),
                      ),
                    ),
                    SizedBox(width: 4),
                    Icon(Icons.arrow_forward_ios, size: 10, color: Color(0xFF64748B)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // Direct AWS IoT Health Check Ping
  Future<void> _pingGateDevice(Map gate) async {
    final gateId = gate['id'] is int ? gate['id'] as int : int.tryParse(gate['id']?.toString() ?? '') ?? 0;
    if (gateId == 0) return;
    final lcNumber = gate['lcNumber'] ?? 'LC Gate';

    AppFeedback.showInfo(context, 'Pinging $lcNumber hardware over AWS IoT...');
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/lc-gates/$gateId/health-check'),
        headers: {
          'Authorization': 'Bearer $_token',
          'Content-Type': 'application/json',
        },
      ).timeout(const Duration(seconds: 10));

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          final isDelivered = data['mqttDelivered'] == true;
          AppFeedback.showSuccess(
            context,
            isDelivered
                ? 'Ping delivered over AWS IoT Core for $lcNumber: Device HEALTHY'
                : 'Ping command registered for $lcNumber: Status HEALTHY',
          );
          _fetchGateTelemetry(gateId);
        }
      } else {
        if (mounted) {
          AppFeedback.showError(context, 'Health ping failed (HTTP ${res.statusCode})');
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Ping error: $e');
      }
    }
  }

    // Modernized Cluster Card with Primary Gate Status Focus (No Coordinates)
  Widget _buildClusterCard(Map<String, dynamic> gate) {
    final masters = gate['masters'] as List?;
    final int rawMastersCount = (gate['mastersCount'] as int?) ?? (masters?.length ?? 0);
    final bool hasMaster = (gate['hasMaster'] as bool?) ?? (rawMastersCount > 0);
    final masterCount = rawMastersCount;
    int slaveCount = 0;
    bool isSolar = false;
    if (masters != null) {
      for (final m in masters) {
        if (m is Map) {
          if (m['powerSource'] == 'SOLAR') isSolar = true;
          final children = m['childDevices'] as List?;
          if (children != null) slaveCount += children.length;
        }
      }
    }
    final deviceRegistries = (gate['deviceRegistries'] as List?) ?? [];
    final bool hasHardware = hasMaster && (
      deviceRegistries.any((d) => d is Map && d['masterId'] != null) ||
      (masters != null && masters.any((m) => m is Map && (
        (m['deviceRegistries'] as List?)?.isNotEmpty == true ||
        (m['awsThingName'] != null && m['awsThingName'].toString().isNotEmpty) ||
        (m['serialNumber'] != null && !m['serialNumber'].toString().contains('(Virtual Master)') && m['isVirtual'] == false)
      )))
    );

    final gateStatus = _getGateStatus(gate);
    final isGateOpen = gateStatus == 'OPEN';
    final isUnconfigured = !hasMaster || !hasHardware || gateStatus == 'UNCONFIGURED';

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: const [
          BoxShadow(color: Color(0x06000000), offset: Offset(0, 1), blurRadius: 3),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Top Row: Gate Title + Status / Power Pills
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    Expanded(
                      child: Text(
                        gate['lcNumber'] ?? 'LC Gate',
                        style: const TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w800,
                          color: Color(0xFF0F172A),
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (hasHardware) ...[
                          Builder(
                            builder: (context) {
                              final isOnline = gate['deviceStatus'] == 'ONLINE' || gate['isOnline'] == true;
                              return Container(
                                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3.5),
                                decoration: BoxDecoration(
                                  color: isOnline ? const Color(0xFFECFDF5) : const Color(0xFFFEF2F2),
                                  borderRadius: BorderRadius.circular(6),
                                  border: Border.all(color: isOnline ? const Color(0xFFA7F3D0) : const Color(0xFFFECACA)),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Container(
                                      width: 6,
                                      height: 6,
                                      decoration: BoxDecoration(
                                        shape: BoxShape.circle,
                                        color: isOnline ? const Color(0xFF10B981) : const Color(0xFFEF4444),
                                      ),
                                    ),
                                    const SizedBox(width: 4),
                                    Text(
                                      isOnline ? 'ONLINE' : 'OFFLINE',
                                      style: TextStyle(
                                        fontSize: 10,
                                        fontWeight: FontWeight.bold,
                                        letterSpacing: 0.3,
                                        color: isOnline ? const Color(0xFF047857) : const Color(0xFFB91C1C),
                                      ),
                                    ),
                                  ],
                                ),
                              );
                            },
                          ),
                          const SizedBox(width: 6),
                        ],
                        if (hasMaster)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(
                              color: isSolar ? const Color(0xFFFEF3C7) : const Color(0xFFDBEAFE),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  isSolar ? Icons.wb_sunny_outlined : Icons.bolt,
                                  size: 11,
                                  color: isSolar ? const Color(0xFFD97706) : const Color(0xFF2563EB),
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  isSolar ? 'Solar' : 'Direct',
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.bold,
                                    color: isSolar ? const Color(0xFFD97706) : const Color(0xFF2563EB),
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
                if (gate['name'] != null && gate['name'] != gate['lcNumber'] && gate['name'] != gate['locationName']) ...[
                  const SizedBox(height: 2),
                  Text(
                    gate['name'],
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF64748B)),
                  ),
                ],
                const SizedBox(height: 3),

                // Zone, Division & Station (Clean, NO GPS Coordinates)
                Builder(
                  builder: (context) {
                    final stName = gate['station'] != null
                        ? (gate['station']['name'] ?? gate['station']['code'])
                        : gate['stationName'];
                    return Row(
                      children: [
                        const Icon(Icons.train_outlined, size: 12, color: Color(0xFF64748B)),
                        const SizedBox(width: 4),
                        Expanded(
                          child: Text(
                            '${gate['zone'] ?? 'CR'} • ${gate['division'] ?? 'Mumbai'}${stName != null ? " • $stName" : ""}',
                            style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    );
                  },
                ),
                const SizedBox(height: 8),

                // PRIMARY GATE STATUS: Strictly UNCONFIGURED, OPENED or CLOSE
                if (isUnconfigured)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF1F5F9),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: const Color(0xFFCBD5E1)),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 7,
                          height: 7,
                          decoration: const BoxDecoration(
                            color: Color(0xFF64748B),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        const Text(
                          'UNCONFIGURED',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w800,
                            color: Color(0xFF475569),
                            letterSpacing: 0.5,
                          ),
                        ),
                      ],
                    ),
                  )
                else
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: isGateOpen ? const Color(0xFFFEE2E2) : const Color(0xFFDCFCE7),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: isGateOpen ? const Color(0xFFFCA5A5) : const Color(0xFF86EFAC)),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 7,
                          height: 7,
                          decoration: BoxDecoration(
                            color: isGateOpen ? const Color(0xFFB91C1C) : const Color(0xFF15803D),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          isGateOpen ? 'OPENED' : 'CLOSE',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w800,
                            color: isGateOpen ? const Color(0xFFB91C1C) : const Color(0xFF15803D),
                            letterSpacing: 0.5,
                          ),
                        ),
                      ],
                    ),
                  ),
                const SizedBox(height: 8),

                // Secondary Details: Device Summary in a single minimal line
                Row(
                  children: [
                    const Icon(Icons.developer_board_outlined, size: 12, color: Color(0xFF64748B)),
                    const SizedBox(width: 4),
                    Text(
                      '$masterCount Master Unit${masterCount == 1 ? "" : "s"} • $slaveCount Slave Sensor${slaveCount == 1 ? "" : "s"}',
                      style: const TextStyle(fontSize: 11, color: Color(0xFF64748B), fontWeight: FontWeight.w500),
                    ),
                  ],
                ),
              ],
            ),
          ),

          // Action Buttons Footer
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: const BoxDecoration(
              color: Color(0xFFF8FAFC),
              border: Border(top: BorderSide(color: Color(0xFFE2E8F0))),
              borderRadius: BorderRadius.only(
                bottomLeft: Radius.circular(12),
                bottomRight: Radius.circular(12),
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      side: const BorderSide(color: Color(0xFFCBD5E1)),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                    ),
                    icon: const Icon(Icons.info_outline, size: 14, color: Color(0xFF0F172A)),
                    label: const Text('About / View', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF0F172A))),
                    onPressed: () => _openClusterDetail(gate, 'about'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                    ),
                    icon: const Icon(Icons.history_rounded, size: 14, color: Colors.white),
                    label: const Text('Gate Records', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.white)),
                    onPressed: () => _openClusterDetail(gate, 'telemetry'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ==========================================================
  // CLUSTER DRILLDOWN (DETAIL VIEW)ER DRILLDOWN (DETAIL VIEW)
  // ==========================================================
  Widget _buildDetailView() {
    final gate = _selectedGate!;
    final masters = gate['masters'] as List?;
    final isSolar = masters?.any((m) => m is Map && m['powerSource'] == 'SOLAR') ?? false;
    final lat = gate['latitude'];
    final lng = gate['longitude'];
    final scopeGroups = gate['scopeGroups'] as List?;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Back Button & Header Quick Actions
        Wrap(
          spacing: 8,
          runSpacing: 6,
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            TextButton.icon(
              style: TextButton.styleFrom(padding: EdgeInsets.zero, visualDensity: VisualDensity.compact),
              onPressed: () {
                _disconnectTelemetryWs();
                setState(() {
                  _viewMode = 'folder';
                  _selectedGate = null;
                });
              },
              icon: const Icon(Icons.arrow_back, size: 16),
              label: const Text('Back', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (masters != null && masters.isNotEmpty) ...[
                  InkWell(
                    onTap: () => _pingGateDevice(gate),
                    borderRadius: BorderRadius.circular(6),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEFF6FF),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: const Color(0xFFBFDBFE)),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.wifi_tethering, size: 12, color: Color(0xFF1D4ED8)),
                          SizedBox(width: 4),
                          Text('Ping Device', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8))),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: isSolar ? const Color(0xFFFEF3C7) : const Color(0xFFDBEAFE),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          isSolar ? Icons.wb_sunny_outlined : Icons.bolt,
                          size: 11,
                          color: isSolar ? const Color(0xFFD97706) : const Color(0xFF2563EB),
                        ),
                        const SizedBox(width: 4),
                        Text(
                          isSolar ? 'Solar Powered' : 'Direct AC',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                            color: isSolar ? const Color(0xFFD97706) : const Color(0xFF2563EB),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
        const SizedBox(height: 10),

        // Detail Header Card
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFE2E8F0)),
            boxShadow: const [
              BoxShadow(color: Color(0x06000000), offset: Offset(0, 1), blurRadius: 2),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      gate['lcNumber'] ?? 'LC Gate',
                      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (gate['name'] != null && gate['name'] != gate['lcNumber'] && gate['name'] != gate['locationName'])
                    Text(
                      gate['name'],
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFF64748B)),
                    ),
                ],
              ),
              const SizedBox(height: 8),

              Builder(
                builder: (context) {
                  final stName = gate['station'] != null
                      ? '${gate['station']['name']} (${gate['station']['code']})'
                      : gate['stationName'];
                  return Row(
                    children: [
                      const Icon(Icons.train_outlined, size: 13, color: Color(0xFF64748B)),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          'Zone: ${gate['zone'] ?? 'CR'} • Division: ${gate['division'] ?? 'Mumbai'}${stName != null ? " • Station: $stName" : ""}',
                          style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  );
                },
              ),
              if (lat != null && lng != null) ...[
                const SizedBox(height: 4),
                InkWell(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: '$lat, $lng'));
                    AppFeedback.showSuccess(context, 'Coordinates copied: $lat, $lng');
                  },
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.location_on, size: 13, color: Color(0xFFEF4444)),
                      const SizedBox(width: 4),
                      Text(
                        'GPS: ${(lat as num).toStringAsFixed(5)}, ${(lng as num).toStringAsFixed(5)}',
                        style: const TextStyle(fontSize: 12, color: Color(0xFF0284C7), fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(width: 4),
                      const Icon(Icons.copy, size: 11, color: Color(0xFF0284C7)),
                    ],
                  ),
                ),
              ],

              // Scope Group badges
              if (scopeGroups != null && scopeGroups.isNotEmpty) ...[
                const SizedBox(height: 12),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: scopeGroups.map((sg) {
                    final sgName = sg['scopeGroup']?['name'] ?? 'Assigned Scope Group';
                    return Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEFF6FF),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: const Color(0xFFBFDBFE)),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.layers_outlined, size: 11, color: Color(0xFF1D4ED8)),
                          const SizedBox(width: 4),
                          Text(sgName, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8))),
                        ],
                      ),
                    );
                  }).toList(),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 14),

        // Detail Tabs Switcher: About Cluster vs Live Telemetry & Inspect
        Container(
          decoration: BoxDecoration(
            color: const Color(0xFFE2E8F0),
            borderRadius: BorderRadius.circular(8),
          ),
          padding: const EdgeInsets.all(3),
          child: Row(
            children: [
              Expanded(
                child: InkWell(
                  onTap: () {
                    _disconnectTelemetryWs();
                    setState(() => _clusterTab = 'about');
                  },
                  borderRadius: BorderRadius.circular(6),
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: _clusterTab == 'about' ? Colors.white : Colors.transparent,
                      borderRadius: BorderRadius.circular(6),
                      boxShadow: _clusterTab == 'about'
                          ? const [BoxShadow(color: Color(0x0A000000), offset: Offset(0, 1), blurRadius: 2)]
                          : null,
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.info_outline, size: 14, color: _clusterTab == 'about' ? AppColors.primary : const Color(0xFF64748B)),
                        const SizedBox(width: 5),
                        Flexible(
                          child: Text(
                            'About LC Gate',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              color: _clusterTab == 'about' ? AppColors.primary : const Color(0xFF64748B),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              Expanded(
                child: InkWell(
                  onTap: () {
                    setState(() => _clusterTab = 'telemetry');
                    final gateId = gate['id'];
                    final idNum = gateId is int ? gateId : int.tryParse(gateId?.toString() ?? '') ?? 0;
                    if (idNum > 0) {
                      _connectTelemetryWs(idNum);
                    }
                  },
                  borderRadius: BorderRadius.circular(6),
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: _clusterTab == 'telemetry' ? Colors.white : Colors.transparent,
                      borderRadius: BorderRadius.circular(6),
                      boxShadow: _clusterTab == 'telemetry'
                          ? const [BoxShadow(color: Color(0x0A000000), offset: Offset(0, 1), blurRadius: 2)]
                          : null,
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.history_rounded, size: 14, color: _clusterTab == 'telemetry' ? AppColors.primary : const Color(0xFF64748B)),
                        const SizedBox(width: 5),
                        Flexible(
                          child: Text(
                            'Operational Records',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              color: _clusterTab == 'telemetry' ? AppColors.primary : const Color(0xFF64748B),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),

        // Tab Content
        if (_clusterTab == 'about')
          _buildAboutTab(gate, isSolar, lat, lng)
        else
          _buildOperationalHistoryTab(gate),
      ],
    );
  }

  // ==========================================================
  // TAB 1: ABOUT CLUSTER & DEVICE-WISE HARDWARE EVIDENCE CONSOLE
  // ==========================================================
  Widget _buildAboutTab(Map<String, dynamic> gate, bool isSolar, dynamic lat, dynamic lng) {
    final masters = (gate['masters'] as List?) ?? [];
    int slaveCount = 0;
    for (final m in masters) {
      if (m is Map) {
        final children = m['childDevices'] as List?;
        if (children != null) slaveCount += children.length;
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 1. Geographical Location Card (Clean & Compact)
        _buildSectionCard(
          title: 'Geographical Location',
          icon: Icons.location_on_outlined,
          iconColor: const Color(0xFFEF4444),
          children: [
            _buildFieldRow('LC Gate Number', gate['lcNumber'] ?? 'N/A'),
            _buildFieldRow('Railway Zone', gate['zone'] ?? 'CR'),
            _buildFieldRow('Railway Division', gate['division'] ?? 'Mumbai'),
            _buildFieldRow('Location / Station', gate['name'] ?? gate['locationName'] ?? 'N/A'),
            _buildFieldRow(
              'GPS Geotag',
              lat != null && lng != null ? '${(lat as num).toStringAsFixed(5)}, ${(lng as num).toStringAsFixed(5)}' : 'Not Specified',
            ),
          ],
        ),
        const SizedBox(height: 14),

        // 2. Hardware Configuration Card (Compact)
        _buildSectionCard(
          title: 'Hardware Configuration',
          icon: Icons.memory,
          iconColor: AppColors.primary,
          children: [
            _buildFieldRow('Primary Power', masters.isNotEmpty ? (isSolar ? 'Solar Powered' : 'Direct AC Mains') : 'Not Configured'),
            _buildFieldRow('Configured Masters', '${masters.length} Gateway Unit(s)'),
            _buildFieldRow('Connected Slave Sensors', '$slaveCount Device(s)'),
            _buildFieldRow('System Status', masters.isNotEmpty ? 'Configured (Active)' : 'Unconfigured (No Master)'),
          ],
        ),
        const SizedBox(height: 18),

        // 3. Unified Configured Hardware & Installation Evidence Console
        Padding(
          padding: const EdgeInsets.only(left: 2, bottom: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Configured Hardware & Installation Evidence',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
              ),
              const SizedBox(height: 2),
              Text(
                'Hardware units & verified installation evidence photos uploaded during setup.',
                style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),

        if (masters.isEmpty)
          _buildEmptyCard(
            icon: Icons.memory,
            title: 'No Master Devices Configured',
            message: 'This LC Gate currently does not have master hardware units configured.',
          )
        else
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: masters.length,
            separatorBuilder: (context, index) => const SizedBox(height: 12),
            itemBuilder: (context, mIdx) {
              final rawMaster = masters[mIdx];
              if (rawMaster is! Map) return const SizedBox.shrink();
              final master = Map<String, dynamic>.from(rawMaster);
              final childDevices = (master['childDevices'] as List?) ?? [];
              final isMasterExpanded = _expandedMasterIndex == mIdx;
              final masterSerial = (master['serialNumber'] ?? '').toString();
              final masterDevices = (master['deviceRegistries'] as List?) ?? [];
              final gateDevices = (gate['deviceRegistries'] as List?) ?? [];
              final matchingGateDev = gateDevices.firstWhere(
                (d) => d is Map && (
                  (d['masterId'] != null && d['masterId'] == master['id']) ||
                  (d['thingName'] != null && d['thingName'] == master['serialNumber']) ||
                  (d['thingName'] != null && master['awsThingName'] != null && d['thingName'] == master['awsThingName'])
                ),
                orElse: () => null,
              );
              final hasHardware = masterDevices.isNotEmpty || matchingGateDev != null || (master['awsThingName'] != null && master['isVirtual'] == false);
              final isVirtual = masterSerial.contains('(Virtual Master)') || !hasHardware;
              final dynamic linkedDevObj = masterDevices.isNotEmpty ? masterDevices[0] : matchingGateDev;
              final linkedDevName = linkedDevObj != null ? (linkedDevObj['thingName'] ?? linkedDevObj['serialNumber']) : master['awsThingName'];

              // Extract component-wise evidence photos uploaded during setup
              final masterEv = _findDeviceEvidence(master, 'MASTER');
              final simEv = _findDeviceEvidence(master, 'SIM_CARD');
              final powerEv = _findDeviceEvidence(master, 'POWER_SOURCE');

              return Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                  boxShadow: const [
                    BoxShadow(color: Color(0x06000000), offset: Offset(0, 1), blurRadius: 2),
                  ],
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Master Header Accordion Bar (Expandable/Collapsible once at a time)
                    InkWell(
                      onTap: () {
                        setState(() {
                          _expandedMasterIndex = isMasterExpanded ? null : mIdx;
                        });
                      },
                      borderRadius: BorderRadius.circular(12),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Row(
                          children: [
                            Container(
                              width: 36,
                              height: 36,
                              decoration: BoxDecoration(
                                color: const Color(0xFFE0F2FE),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: const Icon(Icons.memory, color: Color(0xFF0369A1), size: 20),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Text(
                                          'Master #${master['masterSequence']}: ${master['serialNumber']}',
                                          style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                      const SizedBox(width: 6),
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                                        decoration: BoxDecoration(
                                          color: isVirtual ? const Color(0xFFFEF3C7) : const Color(0xFFDCFCE7),
                                          borderRadius: BorderRadius.circular(10),
                                          border: Border.all(
                                            color: isVirtual ? const Color(0xFFFDE68A) : const Color(0xFF86EFAC),
                                          ),
                                        ),
                                        child: Text(
                                          isVirtual ? 'VIRTUAL' : 'LINKED',
                                          style: TextStyle(
                                            fontSize: 9.5,
                                            fontWeight: FontWeight.bold,
                                            color: isVirtual ? const Color(0xFFD97706) : const Color(0xFF15803D),
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                  Text(
                                    'Primary Gateway • ${master['powerSource'] == 'SOLAR' ? 'Solar Powered' : 'Direct AC Power'}',
                                    style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                                  ),
                                ],
                              ),
                            ),
                            Icon(
                              isMasterExpanded ? Icons.expand_less : Icons.expand_more,
                              color: const Color(0xFF64748B),
                            ),
                          ],
                        ),
                      ),
                    ),

                    if (isMasterExpanded) ...[
                      const Divider(height: 1, color: Color(0xFFF1F5F9)),
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            // Hardware Link & Device Topology Status Banner
                            Container(
                              margin: const EdgeInsets.only(bottom: 12),
                              padding: const EdgeInsets.all(10),
                              decoration: BoxDecoration(
                                color: isVirtual ? const Color(0xFFFFFBEB) : const Color(0xFFF0FDF4),
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(
                                  color: isVirtual ? const Color(0xFFFDE68A) : const Color(0xFFBBF7D0),
                                ),
                              ),
                              child: Row(
                                children: [
                                  Icon(
                                    isVirtual ? Icons.router_outlined : Icons.check_circle_outline,
                                    size: 18,
                                    color: isVirtual ? const Color(0xFFD97706) : const Color(0xFF16A34A),
                                  ),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          isVirtual ? 'Virtual Master (No Physical Hardware Linked)' : 'Linked to AWS IoT Device${linkedDevName != null ? ' ($linkedDevName)' : ''}',
                                          style: TextStyle(
                                            fontSize: 11.5,
                                            fontWeight: FontWeight.bold,
                                            color: isVirtual ? const Color(0xFF92400E) : const Color(0xFF166534),
                                          ),
                                        ),
                                        Text(
                                          isVirtual
                                              ? 'Tap to link provisioned edge hardware at any time'
                                              : 'Receiving live gate operations from AWS IoT Core',
                                          style: TextStyle(
                                            fontSize: 10.5,
                                            color: isVirtual ? const Color(0xFFB45309) : const Color(0xFF15803D),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  ElevatedButton.icon(
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: isVirtual ? const Color(0xFF0F172A) : const Color(0xFF475569),
                                      foregroundColor: Colors.white,
                                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                      minimumSize: Size.zero,
                                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                    ),
                                    onPressed: () => _showLinkHardwareSheet(master, gate),
                                    icon: Icon(isVirtual ? Icons.link : Icons.tune, size: 12),
                                    label: Text(
                                      isVirtual ? 'Link Hardware' : 'Manage Device',
                                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
                                    ),
                                  ),
                                ],
                              ),
                            ),

                            // Component 1: Master Unit (ESP Gateway) & Its Uploaded Evidence Photo
                            _buildDeviceEvidenceCard(
                              title: 'Master Gateway Unit (ESP)',
                              subtitle: 'Serial: ${master['serialNumber']} • Primary Gateway Unit',
                              icon: Icons.memory,
                              iconColor: const Color(0xFF0284C7),
                              evidence: masterEv,
                              gate: gate,
                              masterSeq: master['masterSequence'],
                              emptyLabel: 'No installation photo uploaded for Master unit.',
                            ),
                            const SizedBox(height: 10),

                            // Component 1.5: Installed SIM Card Evidence Photo
                            _buildDeviceEvidenceCard(
                              title: 'Installed SIM Card',
                              subtitle: 'Cellular SIM & ICCID Proof',
                              icon: Icons.sim_card_outlined,
                              iconColor: const Color(0xFF0D9488),
                              evidence: simEv,
                              gate: gate,
                              masterSeq: master['masterSequence'],
                              emptyLabel: 'No installation photo uploaded for SIM card.',
                            ),
                            const SizedBox(height: 10),

                            // Component 2: Power Source & Its Uploaded Evidence Photo
                            _buildDeviceEvidenceCard(
                              title: master['powerSource'] == 'SOLAR' ? 'Solar Power Source' : 'Direct AC Power Source',
                              subtitle: master['powerSource'] == 'SOLAR' ? 'Solar Panels & Battery System' : 'Direct Grid AC Power Supply',
                              icon: master['powerSource'] == 'SOLAR' ? Icons.wb_sunny_outlined : Icons.bolt,
                              iconColor: master['powerSource'] == 'SOLAR' ? const Color(0xFFD97706) : const Color(0xFF2563EB),
                              evidence: powerEv,
                              gate: gate,
                              masterSeq: master['masterSequence'],
                              emptyLabel: 'No installation photo uploaded for Power source.',
                            ),
                            const SizedBox(height: 12),

                            // Component 3: Connected Slave Devices & Their Uploaded Evidence Photos
                            Container(
                              padding: const EdgeInsets.all(10),
                              decoration: BoxDecoration(
                                color: const Color(0xFFF8FAFC),
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(color: const Color(0xFFE2E8F0)),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      const Icon(Icons.power_outlined, size: 14, color: Color(0xFF0284C7)),
                                      const SizedBox(width: 4),
                                      Text(
                                        'Connected Slave Devices (${childDevices.length})',
                                        style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Color(0xFF475569)),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 8),

                                  if (childDevices.isEmpty)
                                    const Padding(
                                      padding: EdgeInsets.symmetric(vertical: 4),
                                      child: Text('No slave devices configured for this master.', style: TextStyle(fontSize: 11, color: Color(0xFF94A3B8))),
                                    )
                                  else
                                    ListView.separated(
                                      shrinkWrap: true,
                                      physics: const NeverScrollableScrollPhysics(),
                                      itemCount: childDevices.length,
                                      separatorBuilder: (context, index) => const SizedBox(height: 8),
                                      itemBuilder: (context, cIdx) {
                                        final rawChild = childDevices[cIdx];
                                        if (rawChild is! Map) return const SizedBox.shrink();
                                        final child = Map<String, dynamic>.from(rawChild);
                                        final childEv = _findDeviceEvidence(master, child['type'], child['id']);
                                        final isSlaveExpanded = _expandedSlaveId == child['id'];

                                        return Container(
                                          decoration: BoxDecoration(
                                            color: Colors.white,
                                            borderRadius: BorderRadius.circular(6),
                                            border: Border.all(color: const Color(0xFFE2E8F0)),
                                          ),
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.stretch,
                                            children: [
                                              // Slave Accordion Row
                                              InkWell(
                                                onTap: () {
                                                  setState(() {
                                                    _expandedSlaveId = isSlaveExpanded ? null : child['id'];
                                                  });
                                                },
                                                borderRadius: BorderRadius.circular(6),
                                                child: Padding(
                                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                                  child: Row(
                                                    children: [
                                                      Expanded(
                                                        child: Column(
                                                          crossAxisAlignment: CrossAxisAlignment.start,
                                                          children: [
                                                            Text(
                                                              child['serialNumber'] ?? 'Slave Device',
                                                              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                                            ),
                                                            Text(
                                                              '${child['type'] ?? 'Device'} • Sequence #${child['deviceSequence']}',
                                                              style: const TextStyle(fontSize: 10, color: Color(0xFF64748B)),
                                                            ),
                                                          ],
                                                        ),
                                                      ),
                                                      Icon(
                                                        isSlaveExpanded ? Icons.expand_less : Icons.expand_more,
                                                        size: 18,
                                                        color: const Color(0xFF64748B),
                                                      ),
                                                    ],
                                                  ),
                                                ),
                                              ),

                                              // Slave Photo & Sensor Details when Expanded
                                              if (isSlaveExpanded) ...[
                                                const Divider(height: 1, color: Color(0xFFF1F5F9)),
                                                Padding(
                                                  padding: const EdgeInsets.all(8),
                                                  child: Column(
                                                    crossAxisAlignment: CrossAxisAlignment.start,
                                                    children: [
                                                      Text(
                                                        child['type'] == 'DEVICE_2'
                                                            ? 'Sensors: Tilt & Vibration Sensor'
                                                            : 'Sensors: LimitSwitch & HallEffect Position Detection',
                                                        style: const TextStyle(fontSize: 10.5, color: Color(0xFF475569), fontWeight: FontWeight.w500),
                                                      ),
                                                      const SizedBox(height: 6),
                                                      _buildPhotoThumbnailRow(
                                                        evidence: childEv,
                                                        gate: gate,
                                                        itemTitle: 'Slave: ${child['serialNumber']}',
                                                        masterSeq: master['masterSequence'],
                                                        deviceSeq: child['deviceSequence'],
                                                        emptyMessage: 'No installation photo uploaded for this slave sensor.',
                                                      ),
                                                    ],
                                                  ),
                                                ),
                                              ],
                                            ],
                                          ),
                                        );
                                      },
                                    ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              );
            },
          ),
      ],
    );
  }

  // Component Evidence Card Builder
  Widget _buildDeviceEvidenceCard({
    required String title,
    required String subtitle,
    required IconData icon,
    required Color iconColor,
    required Map<String, dynamic>? evidence,
    required Map<String, dynamic> gate,
    required int? masterSeq,
    required String emptyLabel,
  }) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 14, color: iconColor),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                ),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(subtitle, style: const TextStyle(fontSize: 10, color: Color(0xFF64748B))),
          const SizedBox(height: 8),
          _buildPhotoThumbnailRow(
            evidence: evidence,
            gate: gate,
            itemTitle: title,
            masterSeq: masterSeq,
            emptyMessage: emptyLabel,
          ),
        ],
      ),
    );
  }

  // Photo Thumbnail Row with High Quality Full Photo Modal
  Widget _buildPhotoThumbnailRow({
    required Map<String, dynamic>? evidence,
    required Map<String, dynamic> gate,
    required String itemTitle,
    int? masterSeq,
    int? deviceSeq,
    required String emptyMessage,
  }) {
    if (evidence == null) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Row(
          children: [
            const Icon(Icons.photo_camera_back_outlined, size: 16, color: Color(0xFF94A3B8)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                emptyMessage,
                style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
              ),
            ),
          ],
        ),
      );
    }

    final imgUrl = getFullImageUrl(evidence['imageUrl']?.toString());
    final lat = evidence['latitude'];
    final lng = evidence['longitude'];

    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Row(
        children: [
          InkWell(
            onTap: () => _showEvidenceDialog(
              gate: gate,
              evidence: evidence,
              itemTitle: itemTitle,
              masterSeq: masterSeq,
              deviceSeq: deviceSeq,
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: SizedBox(
                width: 48,
                height: 48,
                child: Image.network(
                  imgUrl,
                  fit: BoxFit.cover,
                  errorBuilder: (context, error, stackTrace) => Container(
                    color: Colors.grey.shade200,
                    child: const Icon(Icons.broken_image, color: Colors.grey, size: 18),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  lat != null && lng != null
                      ? 'GPS: ${(lat as num).toStringAsFixed(4)}, ${(lng as num).toStringAsFixed(4)}'
                      : 'Site Photo Attached',
                  style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                ),
                Text(
                  'Uploaded at setup • Tap to zoom',
                  style: const TextStyle(fontSize: 9.5, color: Color(0xFF64748B)),
                ),
              ],
            ),
          ),
          OutlinedButton(
            style: OutlinedButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
            ),
            onPressed: () => _showEvidenceDialog(
              gate: gate,
              evidence: evidence,
              itemTitle: itemTitle,
              masterSeq: masterSeq,
              deviceSeq: deviceSeq,
            ),
            child: const Text('View Photo', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  // ==========================================================
  // TAB 2: MINIMALISTIC OPERATIONAL HISTORY & OPEN/CLOSE LOGS
  // ==========================================================
  Widget _buildOperationalHistoryTab(Map<String, dynamic> gate) {
    final gateId = gate['id'] is int ? gate['id'] as int : int.tryParse(gate['id']?.toString() ?? '') ?? 0;
    final masters = (gate['masters'] as List?) ?? [];
    final int rawMastersCount = (gate['mastersCount'] as int?) ?? masters.length;
    final bool hasMaster = (gate['hasMaster'] as bool?) ?? ((_gateTelemetry?['hasMaster'] as bool?) ?? (rawMastersCount > 0));
    final devs = (gate['deviceRegistries'] as List?) ?? [];
    final bool hasHardware = hasMaster && (
      devs.any((d) => d is Map && d['masterId'] != null) ||
      masters.any((m) => m is Map && (
        (m['deviceRegistries'] as List?)?.isNotEmpty == true ||
        (m['awsThingName'] != null && m['awsThingName'].toString().isNotEmpty) ||
        (m['serialNumber'] != null && !m['serialNumber'].toString().contains('(Virtual Master)') && m['isVirtual'] == false)
      ))
    );

    final currentStatus = _gateTelemetry?['currentStatus']?.toString().toUpperCase() ?? 'UNKNOWN';
    final gateOperationalStatus = _getGateStatus(gate);
    final isUnconfigured = !hasMaster || !hasHardware || currentStatus == 'UNCONFIGURED' || gateOperationalStatus == 'UNCONFIGURED';
    final isOpen = !isUnconfigured && (gateOperationalStatus == 'OPEN' || currentStatus == 'OPEN');

    final isDeviceOnline = hasHardware && (_gateTelemetry?['isDeviceOnline'] == true ||
        _gateTelemetry?['deviceStatus'] == 'ONLINE' ||
        gate['deviceStatus'] == 'ONLINE' ||
        gate['isOnline'] == true);

    final operationalCycles = (_gateTelemetry?['operationalCycles'] as List?) ??
        (gate['events'] as List?) ??
        [];

    final lcNumber = (gate['masterSerialNumber'] != null && gate['masterSerialNumber'] != 'Unassigned')
        ? gate['masterSerialNumber'].toString()
        : (gate['lcNumber']?.toString() ?? 'LC-GATE');
    final locationName = gate['name'] ?? gate['locationName'] ?? '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 1. Clean Operational Status Header Bar (No technical telemetry jargon)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFE2E8F0)),
            boxShadow: const [
              BoxShadow(color: Color(0x06000000), offset: Offset(0, 1), blurRadius: 2),
            ],
          ),
          child: Row(
            children: [
              // Prominent Gate Status Pill
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: isUnconfigured
                        ? const Color(0xFFF1F5F9)
                        : (isOpen ? const Color(0xFFFEE2E2) : const Color(0xFFDCFCE7)),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: isUnconfigured
                          ? const Color(0xFFCBD5E1)
                          : (isOpen ? const Color(0xFFFCA5A5) : const Color(0xFF86EFAC)),
                    ),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 9,
                        height: 9,
                        decoration: BoxDecoration(
                          color: isUnconfigured
                              ? const Color(0xFF64748B)
                              : (isOpen ? const Color(0xFFB91C1C) : const Color(0xFF15803D)),
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        isUnconfigured
                            ? 'GATE: UNCONFIGURED'
                            : (isOpen ? 'GATE: OPEN' : 'GATE: CLOSED'),
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w800,
                          color: isUnconfigured
                              ? const Color(0xFF475569)
                              : (isOpen ? const Color(0xFFB91C1C) : const Color(0xFF15803D)),
                          letterSpacing: 0.5,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              if (hasHardware) ...[
                const SizedBox(width: 10),
                // Hardware Online/Offline Status Pill (Only shown if physical hardware is mapped)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    color: isDeviceOnline ? const Color(0xFFECFDF5) : const Color(0xFFFEF2F2),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: isDeviceOnline ? const Color(0xFFA7F3D0) : const Color(0xFFFECACA),
                    ),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: isDeviceOnline ? const Color(0xFF10B981) : const Color(0xFFEF4444),
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        isDeviceOnline ? 'ONLINE' : 'OFFLINE',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w800,
                          color: isDeviceOnline ? const Color(0xFF047857) : const Color(0xFFB91C1C),
                          letterSpacing: 0.3,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              const SizedBox(width: 8),

              // Refresh Button
              IconButton(
                onPressed: _loadingTelemetry ? null : () => _fetchGateTelemetry(gateId),
                tooltip: 'Refresh Operations',
                icon: _loadingTelemetry
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF0284C7)))
                    : const Icon(Icons.refresh_rounded, size: 20, color: Color(0xFF0284C7)),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),

        // 2. Operational History Records Header
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Opening & Closing Records',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Chronological log of boom barrier opening, closing, and duration',
                    style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (operationalCycles.isNotEmpty)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0xFFF1F5F9),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: const Color(0xFFCBD5E1)),
                ),
                child: Text(
                  '${operationalCycles.length} records',
                  style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF334155)),
                ),
              ),
          ],
        ),
        const SizedBox(height: 12),

        // 3. Operational Records List or Empty State
        if (_loadingTelemetry && operationalCycles.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 40),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (operationalCycles.isEmpty)
          _buildEmptyCard(
            icon: Icons.history_toggle_off_rounded,
            title: 'No Operational Records Yet',
            message: 'Gate opening and closing cycles are logged automatically upon boom barrier operation.',
          )
        else
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: operationalCycles.length,
            separatorBuilder: (context, index) => const SizedBox(height: 10),
            itemBuilder: (context, index) {
              final raw = operationalCycles[index];
              if (raw is! Map) return const SizedBox.shrink();
              final cycle = Map<String, dynamic>.from(raw);

              final cycleStatus = (cycle['status']?.toString().toUpperCase()) ?? 'CLOSED';
              final isCycleOpen = cycleStatus == 'OPEN' || cycle['closedAt'] == null;

              DateTime? openedAt;
              if (cycle['openedAt'] != null) {
                openedAt = DateTime.tryParse(cycle['openedAt'].toString())?.toLocal();
              }
              DateTime? closedAt;
              if (cycle['closedAt'] != null) {
                closedAt = DateTime.tryParse(cycle['closedAt'].toString())?.toLocal();
              }

              final openedAtStr = _formatLogTime(openedAt);
              final closedAtStr = isCycleOpen ? 'In Progress' : _formatLogTime(closedAt);
              final durationStr = cycle['formattedDuration']?.toString() ??
                  (cycle['durationSeconds'] != null ? '${cycle['durationSeconds']}s' : '—');
              final trainNumber = cycle['trainNumber']?.toString();
              final operatorName = cycle['openedBy']?.toString() ?? cycle['closedBy']?.toString();

              return Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                  boxShadow: const [
                    BoxShadow(color: Color(0x04000000), offset: Offset(0, 1), blurRadius: 2),
                  ],
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Header: LC Number & Status Badge
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          lcNumber,
                          style: const TextStyle(
                            fontWeight: FontWeight.w800,
                            fontSize: 14.5,
                            color: AppColors.primary,
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: isCycleOpen ? const Color(0xFFFEE2E2) : const Color(0xFFDCFCE7),
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(
                              color: isCycleOpen ? const Color(0xFFFCA5A5) : const Color(0xFF86EFAC),
                            ),
                          ),
                          child: Text(
                            isCycleOpen ? 'OPEN' : cycleStatus,
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.bold,
                              color: isCycleOpen ? const Color(0xFFB91C1C) : const Color(0xFF15803D),
                            ),
                          ),
                        ),
                      ],
                    ),
                    if (locationName.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        locationName,
                        style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                      ),
                    ],
                    const SizedBox(height: 8),

                    // Timestamps & Duration Row
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          'Opened: $openedAtStr',
                          style: const TextStyle(fontSize: 11.5, fontFamily: 'monospace', color: Color(0xFF334155)),
                        ),
                        Text(
                          'Closed: $closedAtStr',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontFamily: 'monospace',
                            color: isCycleOpen ? const Color(0xFFDC2626) : const Color(0xFF334155),
                            fontWeight: isCycleOpen ? FontWeight.bold : FontWeight.normal,
                          ),
                        ),
                        Text(
                          durationStr,
                          style: const TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.bold,
                            color: Color(0xFF0F172A),
                          ),
                        ),
                      ],
                    ),

                    if ((trainNumber != null && trainNumber.isNotEmpty) || (operatorName != null && operatorName.isNotEmpty)) ...[
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          if (trainNumber != null && trainNumber.isNotEmpty) ...[
                            const Icon(Icons.train, size: 12, color: Color(0xFF64748B)),
                            const SizedBox(width: 4),
                            Expanded(
                              child: Text(
                                trainNumber,
                                style: const TextStyle(fontSize: 10.5, color: Color(0xFF64748B), fontStyle: FontStyle.italic),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                          if (operatorName != null && operatorName.isNotEmpty) ...[
                            const SizedBox(width: 8),
                            const Icon(Icons.person_outline, size: 12, color: Color(0xFF64748B)),
                            const SizedBox(width: 3),
                            Text(
                              operatorName,
                              style: const TextStyle(fontSize: 10, color: Color(0xFF64748B)),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ],
                ),
              );
            },
          ),
      ],
    );
  }

  String _formatLogTime(DateTime? dt) {
    if (dt == null) return '—';
    final now = DateTime.now();
    final isToday = dt.year == now.year && dt.month == now.month && dt.day == now.day;
    final timeStr = '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}:${dt.second.toString().padLeft(2, '0')}';
    if (isToday) return timeStr;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${dt.day.toString().padLeft(2, '0')} ${months[dt.month - 1]} $timeStr';
  }

  // Section Card Builder
  Widget _buildSectionCard({
    required String title,
    required IconData icon,
    required Color iconColor,
    required List<Widget> children,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: const [
          BoxShadow(color: Color(0x06000000), offset: Offset(0, 1), blurRadius: 2),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 16, color: iconColor),
              const SizedBox(width: 6),
              Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: Color(0xFF0F172A))),
            ],
          ),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    );
  }

  Widget _buildFieldRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(fontSize: 11, color: Color(0xFF64748B))),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              value,
              textAlign: TextAlign.end,
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF0F172A)),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEmptyCard({
    required IconData icon,
    required String title,
    required String message,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 30, color: const Color(0xFF94A3B8)),
          const SizedBox(height: 8),
          Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Color(0xFF1E293B))),
          const SizedBox(height: 4),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 11, color: Color(0xFF64748B), height: 1.3),
          ),
        ],
      ),
    );
  }

  Future<void> _refreshSelectedGate(int gateId) async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/$gateId'),
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final gateData = data is Map ? (data['cluster'] ?? data) : null;
        if (gateData != null && mounted) {
          setState(() {
            _selectedGate = Map<String, dynamic>.from(gateData);
          });
        }
      }
    } catch (_) {}
  }

  void _showLinkHardwareSheet(Map<String, dynamic> master, Map<String, dynamic> gate) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetCtx) => _HardwareLinkSheet(
        master: master,
        gate: gate,
        token: _token,
        userId: _userId,
        onLinked: () {
          Navigator.pop(sheetCtx);
          final gId = gate['id'] is int ? gate['id'] as int : int.tryParse(gate['id']?.toString() ?? '') ?? 0;
          if (gId > 0) _refreshSelectedGate(gId);
          LCGatesCacheService.instance.markStale(_userId);
          _fetchData(isManual: true);
        },
      ),
    );
  }
}

class _HardwareLinkSheet extends StatefulWidget {
  final Map<String, dynamic> master;
  final Map<String, dynamic> gate;
  final String token;
  final String userId;
  final VoidCallback onLinked;

  const _HardwareLinkSheet({
    required this.master,
    required this.gate,
    required this.token,
    required this.userId,
    required this.onLinked,
  });

  @override
  State<_HardwareLinkSheet> createState() => _HardwareLinkSheetState();
}

class _HardwareLinkSheetState extends State<_HardwareLinkSheet> {
  bool _loading = true;
  bool _submitting = false;
  List<dynamic> _availableDevices = [];
  String? _selectedDeviceId;
  String? _error;

  @override
  void initState() {
    super.initState();
    _fetchUnassignedDevices();
  }

  Future<void> _fetchUnassignedDevices() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/devices?limit=100&deviceType=MASTER&unassigned=true'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map && data['devices'] is List && mounted) {
          final list = (data['devices'] as List).where((d) => d['masterId'] == null).toList();
          setState(() {
            _availableDevices = list;
            _loading = false;
          });
          return;
        }
      }
      throw Exception('Failed to load devices from registry');
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = 'Unable to fetch devices: $e';
          _loading = false;
        });
      }
    }
  }

  Future<void> _linkDevice(int? deviceId) async {
    if (_submitting) return;
    setState(() => _submitting = true);
    try {
      final masterId = widget.master['id'];
      final body = <String, dynamic>{};
      if (deviceId != null) {
        body['deviceId'] = deviceId;
      } else {
        body['unassignDevice'] = true;
      }

      final res = await http.put(
        Uri.parse('$baseUrl/lcgate/masters/$masterId'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${widget.token}',
        },
        body: json.encode(body),
      );

      if (res.statusCode == 200) {
        if (mounted) {
          AppFeedback.showSuccess(
            context,
            deviceId != null
                ? 'AWS IoT Master device linked successfully.'
                : 'Master reverted to Virtual Master.',
          );
        }
        widget.onLinked();
      } else {
        String msg = 'Failed to update hardware mapping';
        try {
          final b = json.decode(res.body);
          if (b['error'] != null) msg = b['error'];
        } catch (_) {}
        if (mounted) AppFeedback.showError(context, msg);
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Error: $e');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final masterSerial = (widget.master['serialNumber'] ?? '').toString();
    final isVirtual = masterSerial.contains('(Virtual Master)') ||
        ((widget.master['deviceRegistries'] as List?)?.isEmpty ?? true);

    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.85,
      ),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Drag handle
          Container(
            margin: const EdgeInsets.only(top: 10, bottom: 6),
            width: 40,
            height: 4,
            decoration: BoxDecoration(
              color: Colors.grey.shade300,
              borderRadius: BorderRadius.circular(2),
            ),
          ),

          // Header
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: const Color(0xFFE0F2FE),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.router_rounded, color: Color(0xFF0284C7), size: 20),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Link AWS IoT Master Device',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                      ),
                      Text(
                        'Master #${widget.master['masterSequence']} • Gate ${widget.gate['lcNumber']}',
                        style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close, size: 20, color: Colors.grey),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),
          const Divider(height: 1),

          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Current Hardware Status Card
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: isVirtual ? const Color(0xFFFFFBEB) : const Color(0xFFF0FDF4),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: isVirtual ? const Color(0xFFFDE68A) : const Color(0xFFBBF7D0),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Row(
                              children: [
                                Icon(
                                  isVirtual ? Icons.info_outline : Icons.check_circle_outline,
                                  size: 16,
                                  color: isVirtual ? const Color(0xFFD97706) : const Color(0xFF16A34A),
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  isVirtual ? 'Virtual Master Status' : 'Physical Hardware Linked',
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.bold,
                                    color: isVirtual ? const Color(0xFF92400E) : const Color(0xFF166534),
                                  ),
                                ),
                              ],
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: isVirtual ? Colors.amber.shade100 : Colors.green.shade100,
                                borderRadius: BorderRadius.circular(10),
                              ),
                              child: Text(
                                isVirtual ? 'VIRTUAL' : 'LINKED',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.bold,
                                  color: isVirtual ? Colors.amber.shade900 : Colors.green.shade900,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          'Identifier: $masterSerial',
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, fontFamily: 'monospace'),
                        ),
                        if (!isVirtual) ...[
                          const SizedBox(height: 10),
                          OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(
                              foregroundColor: const Color(0xFFDC2626),
                              side: const BorderSide(color: Color(0xFFFCA5A5)),
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                            ),
                            onPressed: _submitting ? null : () => _linkDevice(null),
                            icon: const Icon(Icons.link_off, size: 14),
                            label: const Text('Unlink Hardware (Revert to Virtual Master)', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold)),
                          ),
                        ],
                      ],
                    ),
                  ),

                  const SizedBox(height: 18),

                  // Available Unassigned Devices Section
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Available AWS IoT Master Units',
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                      ),
                      IconButton(
                        icon: const Icon(Icons.refresh, size: 18, color: Color(0xFF0284C7)),
                        onPressed: _loading ? null : _fetchUnassignedDevices,
                        tooltip: 'Refresh list',
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),

                  if (_loading)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 30),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else if (_error != null)
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.red.shade50,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: Colors.red.shade200),
                      ),
                      child: Text(_error!, style: TextStyle(color: Colors.red.shade700, fontSize: 12)),
                    )
                  else if (_availableDevices.isEmpty)
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF8FAFC),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFE2E8F0)),
                      ),
                      alignment: Alignment.center,
                      child: Column(
                        children: [
                          Icon(Icons.router_outlined, size: 36, color: Colors.grey.shade400),
                          const SizedBox(height: 8),
                          const Text(
                            'No unassigned Master units available',
                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF334155)),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Provision a new Master unit in the AWS IoT Device Registry first.',
                            textAlign: TextAlign.center,
                            style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600),
                          ),
                        ],
                      ),
                    )
                  else
                    ListView.separated(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      itemCount: _availableDevices.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (context, idx) {
                        final dev = _availableDevices[idx];
                        final devId = dev['id'].toString();
                        final thingName = dev['thingName'] ?? 'Unknown Device';
                        final fw = dev['firmwareVersion'] ?? 'v1.0';
                        final isSelected = _selectedDeviceId == devId;

                        return InkWell(
                          onTap: () {
                            setState(() {
                              _selectedDeviceId = devId;
                            });
                          },
                          borderRadius: BorderRadius.circular(8),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                            decoration: BoxDecoration(
                              color: isSelected ? const Color(0xFFF0F9FF) : Colors.white,
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: isSelected ? const Color(0xFF0284C7) : const Color(0xFFE2E8F0),
                                width: isSelected ? 1.5 : 1,
                              ),
                            ),
                            child: Row(
                              children: [
                                Radio<String>(
                                  value: devId,
                                  groupValue: _selectedDeviceId,
                                  onChanged: (val) {
                                    setState(() => _selectedDeviceId = val);
                                  },
                                  activeColor: const Color(0xFF0284C7),
                                ),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        thingName,
                                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)),
                                      ),
                                      Text(
                                        'Firmware: $fw • AWS IoT Core Master Gateway',
                                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),

                  const SizedBox(height: 20),

                  // Confirm button
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF0F172A),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                      onPressed: (_submitting || _selectedDeviceId == null)
                          ? null
                          : () {
                              final idNum = int.tryParse(_selectedDeviceId!);
                              if (idNum != null) _linkDevice(idNum);
                            },
                      icon: _submitting
                          ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Icon(Icons.link, size: 16),
                      label: Text(
                        _submitting ? 'Linking Hardware...' : 'Link Selected Device',
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
