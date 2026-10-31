import 'dart:async';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import '../config.dart';
import '../main.dart';
import 'roles_screen.dart';
import 'branding_screen.dart';
import 'registration_builder_screen.dart';
import 'cluster/cluster_main_screen.dart';
import 'profile_screen.dart';
import 'scope_groups/scope_groups_screen.dart';
import 'device_registry/device_registry_screen.dart';
import 'lc_gates/lc_gates_screen.dart';
import 'reports/reports_screen.dart';
import 'cluster/full_screen_map_screen.dart';
import '../services/home_cache_service.dart';
import '../services/lc_gates_cache_service.dart';
import '../utils/app_feedback.dart';

class DashboardScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  final VoidCallback onLogout;
  const DashboardScreen({super.key, required this.user, required this.onLogout});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

const List<String> _canonicalModuleOrder = [
  'lc-gates',
  'reports',
  'cluster',
  'devices',
  'device-registry',
  'scope-groups',
  'manage-users',
  'registration',
  'roles',
  'branding',
];

const List<Map<String, String>> _defaultModules = [
  {'name': 'LC Gates', 'slug': 'lc-gates'},
  {'name': 'Reports', 'slug': 'reports'},
  {'name': 'Cluster', 'slug': 'cluster'},
  {'name': 'Device Registry', 'slug': 'devices'},
  {'name': 'Scope Groups', 'slug': 'scope-groups'},
  {'name': 'Manage Users', 'slug': 'manage-users'},
  {'name': 'Registration Builder', 'slug': 'registration'},
  {'name': 'Roles', 'slug': 'roles'},
  {'name': 'Branding', 'slug': 'branding'},
];

String _getModuleTitle(dynamic m) {
  final slug = (m['slug'] ?? '').toString();
  switch (slug) {
    case 'lc-gates':
      return 'LC Gates';
    case 'reports':
      return 'Reports';
    case 'branding':
      return 'Branding';
    case 'cluster':
      return 'Cluster';
    case 'devices':
    case 'device-registry':
      return 'Device Registry';
    case 'scope-groups':
      return 'Scope Groups';
    case 'manage-users':
      return 'Manage Users';
    case 'registration':
      return 'Registration Builder';
    case 'roles':
      return 'Roles';
    default:
      final name = (m['name'] ?? '').toString();
      return name.isNotEmpty ? name : slug;
  }
}

List<dynamic> _sortModules(List<dynamic> rawModules) {
  final list = List<dynamic>.from(rawModules);
  list.sort((a, b) {
    final slugA = (a['slug'] ?? '').toString();
    final slugB = (b['slug'] ?? '').toString();
    int idxA = _canonicalModuleOrder.indexOf(slugA);
    int idxB = _canonicalModuleOrder.indexOf(slugB);
    if (idxA == -1) idxA = 999;
    if (idxB == -1) idxB = 999;
    if (idxA != idxB) return idxA.compareTo(idxB);
    return _getModuleTitle(a).compareTo(_getModuleTitle(b));
  });
  return list;
}

class _DashboardScreenState extends State<DashboardScreen> {
  List<dynamic> _users = [];
  List<dynamic> _roles = [];
  List<dynamic> _systemModules = _sortModules(_defaultModules);
  bool _isLoading = false;
  String _currentView = 'home';
  String _appName = 'LC Platform';
  Map<String, dynamic>? _dashboardSummary;
  bool _loadingSummary = true;
  DateTime? _lastSyncedAt;
  bool _isSyncing = false;
  int? _targetGateId;
  String? _targetGateTab;
  int? _activeGateId;

  String get _userId => (widget.user['id'] ?? widget.user['username'] ?? 'user').toString();

  // Manage Users Search & Filter State
  final _userSearchCtrl = TextEditingController();
  String _userSearchQuery = '';
  String _userStatusFilter = 'ALL';
  final Map<int, int> _pendingRoleSelections = {};

  // Notifications State
  List<dynamic> _notifications = [];
  int _unreadNotifsCount = 0;
  Timer? _notifsTimer;

  bool get _canManageUsers =>
      widget.user['role'] == 'Developer' ||
      ((widget.user['allowedModules'] as List?)?.contains('manage-users') ?? false);

  @override
  void initState() {
    super.initState();
    _loadCachedModules();
    _loadInitialHomeCache().then((_) {
      _syncDashboardSummary(forceFullReload: false);
    });
    _fetchAuxiliaryData();
    _fetchNotifications();
    _notifsTimer = Timer.periodic(const Duration(seconds: 30), (_) => _fetchNotifications());
  }

  Future<void> _loadInitialHomeCache() async {
    final cached = await HomeCacheService.instance.getCachedDashboard(_userId);
    if (cached != null && mounted) {
      setState(() {
        _dashboardSummary = Map<String, dynamic>.from(cached.data);
        _lastSyncedAt = cached.lastSyncedAt;
        _loadingSummary = false;
        final gates = _dashboardSummary!['gates'] as List? ?? [];
        if (gates.isNotEmpty && _activeGateId == null) {
          _activeGateId = gates[0]['id'];
        }
      });
    }
  }

  Future<void> _loadCachedModules() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final cached = prefs.getString('cached_modules');
      if (cached != null && cached.isNotEmpty) {
        final data = json.decode(cached);
        if (data is List && data.isNotEmpty && mounted) {
          setState(() {
            _systemModules = _sortModules(data);
          });
        }
      }
    } catch (_) {}
  }

  @override
  void dispose() {
    _notifsTimer?.cancel();
    _userSearchCtrl.dispose();
    super.dispose();
  }

  Future<String> _getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token') ?? '';
  }

  Future<void> _fetchNotifications() async {
    try {
      final token = await _getToken();
      if (token.isEmpty) return;
      final res = await http.get(
        Uri.parse('$baseUrl/notifications'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted && data is Map) {
          setState(() {
            _notifications = List.from(data['notifications'] ?? []);
            final rawCount = data['unreadCount'];
            _unreadNotifsCount = rawCount is int ? rawCount : (int.tryParse(rawCount?.toString() ?? '0') ?? 0);
          });
        }
      } else if (res.statusCode == 401) {
        _notifsTimer?.cancel();
        HomeCacheService.instance.clearUserCache(_userId);
        LCGatesCacheService.instance.hardClear(_userId);
        widget.onLogout();
      }
    } catch (_) {}
  }

  Future<void> _clearAllNotifications() async {
    if (mounted) {
      setState(() {
        _notifications.clear();
        _unreadNotifsCount = 0;
      });
      AppFeedback.showInfo(context, 'All notifications cleared.');
    }
    try {
      final token = await _getToken();
      await http.post(
        Uri.parse('$baseUrl/notifications/clear-all'),
        headers: {'Authorization': 'Bearer $token'},
      );
    } catch (_) {}
  }

  Future<void> _markAllNotifsRead() async {
    try {
      final token = await _getToken();
      await http.post(
        Uri.parse('$baseUrl/notifications/read-all'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (mounted) {
        setState(() {
          for (var n in _notifications) {
            n['read'] = true;
            n['isRead'] = true;
          }
          _unreadNotifsCount = 0;
        });
        AppFeedback.showSuccess(context, 'All notifications marked as read.');
      }
    } catch (_) {}
  }

  Future<void> _markNotificationRead(String id) async {
    try {
      final token = await _getToken();
      await http.put(
        Uri.parse('$baseUrl/notifications/$id/read'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (mounted) {
        setState(() {
          final item = _notifications.firstWhere((n) => n['id'].toString() == id, orElse: () => null);
          if (item != null && (item['read'] != true && item['isRead'] != true)) {
            item['read'] = true;
            item['isRead'] = true;
            if (_unreadNotifsCount > 0) _unreadNotifsCount--;
          }
        });
      }
    } catch (_) {}
  }

  Future<void> _dismissNotification(String id) async {
    if (mounted) {
      setState(() {
        final item = _notifications.firstWhere((n) => n['id'].toString() == id, orElse: () => null);
        if (item != null && (item['read'] != true && item['isRead'] != true) && _unreadNotifsCount > 0) {
          _unreadNotifsCount--;
        }
        _notifications.removeWhere((n) => n['id'].toString() == id);
      });
      AppFeedback.showInfo(context, 'Notification dismissed.');
    }
    try {
      final token = await _getToken();
      await http.delete(
        Uri.parse('$baseUrl/notifications/$id'),
        headers: {'Authorization': 'Bearer $token'},
      );
    } catch (_) {}
  }

  String _formatRelativeTime(dynamic dateStr) {
    if (dateStr == null) return '';
    try {
      final date = DateTime.parse(dateStr.toString()).toLocal();
      final diff = DateTime.now().difference(date);
      if (diff.inSeconds < 60) return 'Just now';
      if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
      if (diff.inHours < 24) return '${diff.inHours}h ago';
      if (diff.inDays < 7) return '${diff.inDays}d ago';
      return '${date.day}/${date.month}/${date.year}';
    } catch (_) {
      return '';
    }
  }

  void _showNotificationsSheet() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) {
        return StatefulBuilder(
          builder: (context, setSheetState) {
            return Container(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.of(context).size.height * 0.78,
              ),
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Drag Handle
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
                    padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(7),
                          decoration: BoxDecoration(
                            color: AppColors.primary.withOpacity(0.1),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: const Icon(Icons.notifications_active, color: AppColors.primary, size: 20),
                        ),
                        const SizedBox(width: 10),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                const Text(
                                  'Notifications',
                                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: AppColors.textMain),
                                ),
                                if (_unreadNotifsCount > 0) ...[
                                  const SizedBox(width: 8),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                                    decoration: BoxDecoration(
                                      color: AppColors.danger,
                                      borderRadius: BorderRadius.circular(10),
                                    ),
                                    child: Text(
                                      '$_unreadNotifsCount new',
                                      style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                            const Text(
                              'Swipe left/right or tap ✕ to dismiss',
                              style: TextStyle(fontSize: 11, color: Colors.grey),
                            ),
                          ],
                        ),
                        const Spacer(),
                        if (_notifications.isNotEmpty) ...[
                          if (_notifications.any((n) => n['read'] != true && n['isRead'] != true))
                            TextButton.icon(
                              style: TextButton.styleFrom(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                                minimumSize: Size.zero,
                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              ),
                              onPressed: () async {
                                await _markAllNotifsRead();
                                setSheetState(() {});
                              },
                              icon: const Icon(Icons.done_all, size: 14, color: AppColors.primary),
                              label: const Text(
                                'Mark read',
                                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.primary),
                              ),
                            ),
                          const SizedBox(width: 4),
                          TextButton.icon(
                            style: TextButton.styleFrom(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            onPressed: () async {
                              await _clearAllNotifications();
                              setSheetState(() {});
                            },
                            icon: Icon(Icons.delete_sweep_outlined, size: 15, color: Colors.red.shade600),
                            label: Text(
                              'Clear all',
                              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Colors.red.shade600),
                            ),
                          ),
                          const SizedBox(width: 4),
                        ],
                        IconButton(
                          icon: const Icon(Icons.close, size: 20, color: Colors.grey),
                          onPressed: () => Navigator.pop(sheetContext),
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(),
                        ),
                      ],
                    ),
                  ),

                  const Divider(height: 1, thickness: 1),

                  // Notifications List
                  Expanded(
                    child: _notifications.isEmpty
                        ? Padding(
                            padding: const EdgeInsets.symmetric(vertical: 50, horizontal: 24),
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Icon(Icons.notifications_none_rounded, size: 58, color: Colors.grey.shade400),
                                const SizedBox(height: 12),
                                const Text(
                                  'No notifications yet',
                                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.textMain),
                                ),
                                const SizedBox(height: 4),
                                const Text(
                                  "You're all caught up! New requests, clusters, and devices will appear here.",
                                  textAlign: TextAlign.center,
                                  style: TextStyle(fontSize: 12, color: Colors.grey),
                                ),
                              ],
                            ),
                          )
                        : ListView.separated(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                            shrinkWrap: true,
                            itemCount: _notifications.length,
                            separatorBuilder: (_, _) => const SizedBox(height: 8),
                            itemBuilder: (context, index) {
                              final item = _notifications[index];
                              final isRead = item['read'] == true || item['isRead'] == true;
                              final notifType = item['type'] ?? 'info';
                              final itemId = item['id'].toString();

                              IconData typeIcon = Icons.notifications;
                              Color iconColor = AppColors.primary;
                              Color iconBg = AppColors.primary.withOpacity(0.1);

                              if (notifType == 'user_request' || notifType == 'request') {
                                typeIcon = Icons.person_add_alt_1_rounded;
                                iconColor = Colors.orange.shade700;
                                iconBg = Colors.orange.shade50;
                              } else if (notifType == 'cluster_created' || notifType == 'cluster') {
                                typeIcon = Icons.device_hub_rounded;
                                iconColor = Colors.blue.shade700;
                                iconBg = Colors.blue.shade50;
                              } else if (notifType == 'device_registered' || notifType == 'device') {
                                typeIcon = Icons.router_rounded;
                                iconColor = Colors.teal.shade700;
                                iconBg = Colors.teal.shade50;
                              }

                              return Dismissible(
                                key: Key(itemId),
                                direction: DismissDirection.horizontal,
                                background: Container(
                                  decoration: BoxDecoration(
                                    color: Colors.red.shade400,
                                    borderRadius: BorderRadius.circular(10),
                                  ),
                                  alignment: Alignment.centerLeft,
                                  padding: const EdgeInsets.symmetric(horizontal: 18),
                                  child: Row(
                                    children: const [
                                      Icon(Icons.delete_outline, color: Colors.white, size: 20),
                                      SizedBox(width: 6),
                                      Text('Dismiss', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
                                    ],
                                  ),
                                ),
                                secondaryBackground: Container(
                                  decoration: BoxDecoration(
                                    color: Colors.red.shade400,
                                    borderRadius: BorderRadius.circular(10),
                                  ),
                                  alignment: Alignment.centerRight,
                                  padding: const EdgeInsets.symmetric(horizontal: 18),
                                  child: Row(
                                    mainAxisAlignment: MainAxisAlignment.end,
                                    children: const [
                                      Text('Dismiss', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
                                      SizedBox(width: 6),
                                      Icon(Icons.delete_outline, color: Colors.white, size: 20),
                                    ],
                                  ),
                                ),
                                onDismissed: (direction) {
                                  _dismissNotification(itemId);
                                  setSheetState(() {});
                                },
                                child: InkWell(
                                  onTap: () {
                                    if (!isRead) {
                                      _markNotificationRead(itemId);
                                    }
                                    Navigator.pop(sheetContext);
                                    if (item['targetModule'] != null || item['link'] != null) {
                                      setState(() {
                                        _currentView = item['targetModule'] ?? item['link'];
                                      });
                                    }
                                  },
                                  borderRadius: BorderRadius.circular(10),
                                  child: Container(
                                    padding: const EdgeInsets.all(12),
                                    decoration: BoxDecoration(
                                      color: isRead ? Colors.white : const Color(0xFFF0F7FF),
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: isRead ? Colors.grey.shade200 : const Color(0xFF0284C7).withOpacity(0.5),
                                        width: isRead ? 1 : 1.5,
                                      ),
                                      boxShadow: [
                                        BoxShadow(
                                          color: Colors.black.withOpacity(0.02),
                                          blurRadius: 4,
                                          offset: const Offset(0, 2),
                                        )
                                      ],
                                    ),
                                    child: Row(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        // Type Icon Avatar
                                        Container(
                                          padding: const EdgeInsets.all(8),
                                          decoration: BoxDecoration(
                                            color: iconBg,
                                            shape: BoxShape.circle,
                                          ),
                                          child: Icon(typeIcon, color: iconColor, size: 20),
                                        ),
                                        const SizedBox(width: 12),

                                        // Content
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: [
                                              Row(
                                                children: [
                                                  if (!isRead) ...[
                                                    Container(
                                                      width: 7,
                                                      height: 7,
                                                      margin: const EdgeInsets.only(right: 6),
                                                      decoration: const BoxDecoration(
                                                        color: Color(0xFF0284C7),
                                                        shape: BoxShape.circle,
                                                      ),
                                                    ),
                                                  ],
                                                  Expanded(
                                                    child: Text(
                                                      item['title'] ?? 'Notification',
                                                      style: TextStyle(
                                                        fontWeight: isRead ? FontWeight.w600 : FontWeight.bold,
                                                        fontSize: 13.5,
                                                        color: isRead ? Colors.grey.shade800 : const Color(0xFF0F172A),
                                                      ),
                                                      maxLines: 1,
                                                      overflow: TextOverflow.ellipsis,
                                                    ),
                                                  ),
                                                  Text(
                                                    _formatRelativeTime(item['createdAt']),
                                                    style: TextStyle(
                                                      fontSize: 11,
                                                      color: Colors.grey.shade500,
                                                    ),
                                                  ),
                                                ],
                                              ),
                                              const SizedBox(height: 4),
                                              Text(
                                                item['message'] ?? '',
                                                style: TextStyle(
                                                  fontSize: 12.5,
                                                  color: Colors.grey.shade700,
                                                  height: 1.3,
                                                ),
                                              ),
                                              if (item['link'] != null) ...[
                                                const SizedBox(height: 6),
                                                Row(
                                                  children: const [
                                                    Text(
                                                      'Tap to view details',
                                                      style: TextStyle(
                                                        fontSize: 11,
                                                        fontWeight: FontWeight.w600,
                                                        color: AppColors.primary,
                                                      ),
                                                    ),
                                                    SizedBox(width: 2),
                                                    Icon(Icons.arrow_forward, size: 11, color: AppColors.primary),
                                                  ],
                                                ),
                                              ],
                                            ],
                                          ),
                                        ),
                                        const SizedBox(width: 6),

                                        // Individual "x" icon to dismiss
                                        IconButton(
                                          icon: Icon(Icons.close, size: 16, color: Colors.grey.shade400),
                                          padding: EdgeInsets.zero,
                                          constraints: const BoxConstraints(),
                                          tooltip: 'Dismiss',
                                          onPressed: () {
                                            _dismissNotification(itemId);
                                            setSheetState(() {});
                                          },
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              );
                            },
                          ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  Future<void> _syncDashboardSummary({bool forceFullReload = false}) async {
    if (_isSyncing) return;
    setState(() => _isSyncing = true);

    try {
      final token = await _getToken();
      if (token.isEmpty) {
        if (mounted) setState(() => _isSyncing = false);
        return;
      }

      final result = await HomeCacheService.instance.syncDashboard(
        userId: _userId,
        token: token,
        forceFullReload: forceFullReload,
      );

      if (mounted) {
        if (result.cacheData != null) {
          setState(() {
            _dashboardSummary = Map<String, dynamic>.from(result.cacheData!.data);
            _lastSyncedAt = result.cacheData!.lastSyncedAt;
            _loadingSummary = false;
            final gates = _dashboardSummary!['gates'] as List? ?? [];
            if (gates.isNotEmpty && _activeGateId == null) {
              _activeGateId = gates[0]['id'];
            }
          });

          if (forceFullReload && result.status != HomeSyncStatus.offline) {
            AppFeedback.showSuccess(context, 'Dashboard synchronized successfully.');
          }
        } else {
          setState(() {
            _loadingSummary = false;
          });
          if (forceFullReload) {
            AppFeedback.showError(context, 'Unable to synchronize dashboard. Check network.');
          }
        }
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _loadingSummary = false;
        });
      }
    } finally {
      if (mounted) setState(() => _isSyncing = false);
    }
  }

  String _formatSyncTime(DateTime? time) {
    if (time == null) return 'Never';
    final diff = DateTime.now().difference(time);
    if (diff.inSeconds < 45) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${time.day}/${time.month} ${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
  }

  void _navigateToGate(int gateId, [String tab = 'about']) {
    setState(() {
      _targetGateId = gateId;
      _targetGateTab = tab;
      _currentView = 'lc-gates';
    });
  }

  Future<void> _fetchAuxiliaryData({bool force = false}) async {
    if (!force && _roles.isNotEmpty && _users.isNotEmpty) return;
    setState(() => _isLoading = true);
    final token = await _getToken();
    final headers = {'Authorization': 'Bearer $token'};
    try {
      final futures = <Future<http.Response>>[
        _canManageUsers
            ? http.get(Uri.parse('$baseUrl/users'), headers: headers)
            : Future.value(http.Response('{"users":[],"pendingRequests":[]}', 200)),
        http.get(Uri.parse('$baseUrl/roles'), headers: headers),
        http.get(Uri.parse('$baseUrl/modules'), headers: headers),
        http.get(Uri.parse('$baseUrl/settings/branding')),
      ];
      final results = await Future.wait(futures);

      final resUsers = results[0];
      final resRoles = results[1];
      final resMods = results[2];
      final resBranding = results[3];

      if (resRoles.statusCode == 401 || resMods.statusCode == 401 || resUsers.statusCode == 401) {
        _notifsTimer?.cancel();
        HomeCacheService.instance.clearUserCache(_userId);
        LCGatesCacheService.instance.hardClear(_userId);
        widget.onLogout();
        return;
      }

      setState(() {
        try {
          final data = json.decode(resUsers.body);
          _users = data is Map && data['users'] != null ? data['users'] : [];
          _pendingRequests = data is Map && data['pendingRequests'] != null ? data['pendingRequests'] : [];
        } catch (_) {}
        
        try {
          final rolesData = json.decode(resRoles.body);
          _roles = rolesData is List ? rolesData : [];
        } catch (_) {}

        // Pre-fill default role selection for pending requests based on user request
        for (var req in _pendingRequests) {
          final reqId = req['id'];
          if (reqId != null && !_pendingRoleSelections.containsKey(reqId)) {
            int? rId = req['requestedRoleId'];
            if (rId == null && req['data'] != null) {
              try {
                final d = json.decode(req['data']);
                if (d['roleId'] != null) rId = int.tryParse(d['roleId'].toString());
                else if (d['requestedRoleId'] != null) rId = int.tryParse(d['requestedRoleId'].toString());
              } catch (_) {}
            }
            if (rId != null && _roles.any((r) => r['id'] == rId)) {
              _pendingRoleSelections[reqId] = rId;
            } else if (_roles.isNotEmpty) {
              _pendingRoleSelections[reqId] = _roles[0]['id'];
            }
          }
        }
        
        try {
          final modsData = json.decode(resMods.body);
          if (modsData is List && modsData.isNotEmpty) {
            _systemModules = _sortModules(modsData);
            SharedPreferences.getInstance().then((prefs) {
              prefs.setString('cached_modules', json.encode(_systemModules));
            });
          }
        } catch (_) {}

        try {
          final brandingData = json.decode(resBranding.body);
          if (brandingData is Map && brandingData['appName'] != null) {
            _appName = brandingData['appName'];
            SharedPreferences.getInstance().then((prefs) {
              prefs.setString('cached_branding', json.encode(brandingData));
            });
          }
        } catch (_) {}
      });
    } catch (e) {
      print(e);
    } finally {
      setState(() => _isLoading = false);
    }
  }

  List<dynamic> _pendingRequests = [];

  Future<void> _actionUser(
    int id,
    String action, [
    Map<String, dynamic>? body,
    bool isRequest = false,
    String? targetName,
    String? roleName,
  ]) async {
    final token = await _getToken();
    final endpoint = isRequest ? 'request/$id/$action' : '$id/$action';
    try {
      final res = await http.put(
        Uri.parse('$baseUrl/users/$endpoint'),
        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
        body: body != null ? json.encode(body) : null
      );
      if (res.statusCode >= 200 && res.statusCode < 300) {
        _fetchAuxiliaryData(force: true);
        if (mounted) {
          final name = targetName != null && targetName.trim().isNotEmpty ? targetName.trim() : 'User';
          if (action == 'approve') {
            final roleSuffix = roleName != null && roleName.isNotEmpty ? ' with role "$roleName"' : '';
            AppFeedback.showSuccess(context, 'Registration for "$name" approved successfully$roleSuffix!');
          } else if (action == 'reject') {
            AppFeedback.showInfo(context, 'Registration request for "$name" has been rejected.');
          } else if (action == 'deactivate') {
            AppFeedback.showWarning(context, 'User "$name" has been deactivated and access revoked.');
          } else if (action == 'reactivate') {
            AppFeedback.showSuccess(context, 'User "$name" has been reactivated successfully.');
          } else {
            AppFeedback.showSuccess(context, 'Action completed for "$name".');
          }
        }
      } else {
        String errMsg = 'Failed to perform $action on user (HTTP ${res.statusCode})';
        try {
          final data = json.decode(res.body);
          if (data is Map && (data['error'] != null || data['message'] != null)) {
            errMsg = (data['error'] ?? data['message']).toString();
          }
        } catch (_) {}
        if (mounted) {
          AppFeedback.showError(context, errMsg);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Failed to perform $action on user: $e');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading && _systemModules.isEmpty) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }
    
    IconData getIconForModule(String slug) {
      switch (slug) {
        case 'lc-gates': return Icons.meeting_room_outlined;
        case 'reports': return Icons.assessment_outlined;
        case 'manage-users': return Icons.group;
        case 'roles': return Icons.security;
        case 'branding': return Icons.brush;
        case 'registration': return Icons.description;
        case 'cluster': return Icons.device_hub;
        case 'devices':
        case 'device-registry': return Icons.developer_board;
        case 'scope-groups': return Icons.layers;
        default: return Icons.extension;
      }
    }

    return Scaffold(
      appBar: AppBar(
        centerTitle: false,
        titleSpacing: 0,
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              margin: const EdgeInsets.only(right: 8),
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(6),
                image: const DecorationImage(
                  image: AssetImage('assets/app_icon.png'),
                  fit: BoxFit.cover,
                ),
              ),
            ),
            Flexible(
              child: Text(
                _appName,
                style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary, fontSize: 18),
                overflow: TextOverflow.ellipsis,
                maxLines: 1,
              ),
            ),
          ],
        ),
        backgroundColor: AppColors.surface,
        actions: [
          if (_currentView == 'manage-users')
            IconButton(
              icon: const Icon(Icons.refresh, size: 20),
              tooltip: 'Refresh',
              onPressed: () => _fetchAuxiliaryData(force: true),
              padding: const EdgeInsets.all(8),
              constraints: const BoxConstraints(),
            ),
          // Bell Icon before avatar icon in header in the right top corner
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2),
            child: Stack(
              clipBehavior: Clip.none,
              alignment: Alignment.center,
              children: [
                IconButton(
                  icon: const Icon(Icons.notifications, color: AppColors.primary, size: 24),
                  tooltip: 'Notifications',
                  onPressed: _showNotificationsSheet,
                  padding: const EdgeInsets.all(8),
                  constraints: const BoxConstraints(),
                ),
                if (_unreadNotifsCount > 0)
                  Positioned(
                    top: 4,
                    right: 4,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                      decoration: BoxDecoration(
                        color: AppColors.danger,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: Colors.white, width: 1.5),
                      ),
                      constraints: const BoxConstraints(minWidth: 16, minHeight: 16),
                      child: Center(
                        child: Text(
                          _unreadNotifsCount > 9 ? '9+' : '$_unreadNotifsCount',
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 9,
                            fontWeight: FontWeight.bold,
                            height: 1.0,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 4),
          // Avatar Icon in right top corner
          InkWell(
            onTap: () {
              Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => ProfileScreen(user: widget.user)),
              );
            },
            borderRadius: BorderRadius.circular(18),
            child: Tooltip(
              message: 'Profile Settings',
              child: CircleAvatar(
                radius: 16,
                backgroundColor: AppColors.primary,
                child: Text(
                  widget.user['fullName'] != null && widget.user['fullName'].toString().isNotEmpty
                      ? widget.user['fullName'].toString().substring(0, widget.user['fullName'].toString().length >= 2 ? 2 : 1).toUpperCase()
                      : 'U',
                  style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
                ),
              ),
            ),
          ),
          const SizedBox(width: 12),
        ],
      ),
      drawer: Drawer(
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            DrawerHeader(
              decoration: const BoxDecoration(
                color: AppColors.surface,
                border: Border(bottom: BorderSide(color: Color(0xFFE5E7EB), width: 1)),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      CircleAvatar(
                        radius: 24,
                        backgroundColor: AppColors.secondary,
                        child: Text(
                          widget.user['fullName'] != null && widget.user['fullName'].toString().isNotEmpty
                              ? widget.user['fullName'].toString().substring(0, widget.user['fullName'].toString().length >= 2 ? 2 : 1).toUpperCase()
                              : 'U',
                          style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              widget.user['fullName'] ?? 'User',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 2),
                            Text(
                              widget.user['role'] ?? '',
                              style: const TextStyle(color: Colors.grey, fontSize: 13),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  // Profile Settings button below role and above divider before Home
                  InkWell(
                    onTap: () {
                      Navigator.pop(context);
                      Navigator.push(
                        context,
                        MaterialPageRoute(builder: (_) => ProfileScreen(user: widget.user)),
                      );
                    },
                    borderRadius: BorderRadius.circular(8),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      decoration: BoxDecoration(
                        color: AppColors.primary.withOpacity(0.08),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AppColors.primary.withOpacity(0.25)),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: const [
                          Icon(Icons.person_outline_rounded, size: 16, color: AppColors.primary),
                          SizedBox(width: 6),
                          Text(
                            'Profile Settings',
                            style: TextStyle(
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                              color: AppColors.primary,
                            ),
                          ),
                          SizedBox(width: 4),
                          Icon(Icons.chevron_right, size: 16, color: AppColors.primary),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, thickness: 1, color: Color(0xFFE5E7EB)),
            ListTile(
              title: const Text('Home'),
              leading: const Icon(Icons.home),
              onTap: () {
                setState(() { _currentView = 'home'; });
                Navigator.pop(context);
              },
            ),
            ..._systemModules.where((m) {
              if (widget.user['role'] == 'Developer') return true;
              final hasAssignedScopes = widget.user['scopeGroups'] is List && (widget.user['scopeGroups'] as List).isNotEmpty;
              if ((m['slug'] == 'lc-gates' || m['slug'] == 'reports') && hasAssignedScopes) return true;
              final allowed = widget.user['allowedModules'];
              return allowed is List && allowed.contains(m['slug']);
            }).map((m) {
              return ListTile(
                title: Text(_getModuleTitle(m)),
                leading: Icon(getIconForModule(m['slug'])),
                onTap: () {
                  setState(() { _currentView = m['slug']; });
                  Navigator.pop(context);
                }
              );
            }),

            ListTile(
              title: const Text('Logout', style: TextStyle(color: AppColors.danger)),
              leading: const Icon(Icons.logout, color: AppColors.danger),
              onTap: () {
                HomeCacheService.instance.clearUserCache(_userId);
                LCGatesCacheService.instance.hardClear(_userId);
                widget.onLogout();
              },
            ),
          ],
        ),
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_currentView == 'home') return _buildUserDashboard();
    if (_currentView == 'lc-gates') {
      return LCGatesScreen(
        user: widget.user,
        initialGateId: _targetGateId,
        initialTab: _targetGateTab,
      );
    }
    if (_currentView == 'reports') return ReportsScreen(user: widget.user);
    if (_currentView == 'manage-users') return _buildAdminDashboard();
    if (_currentView == 'roles') return RolesScreen(user: widget.user);
    if (_currentView == 'branding') return BrandingScreen(user: widget.user);
    if (_currentView == 'registration') return RegistrationBuilderScreen(user: widget.user);
    if (_currentView == 'cluster') return ClusterMainScreen(user: widget.user);
    if (_currentView == 'devices' || _currentView == 'device-registry') return DeviceRegistryScreen(user: widget.user);
    if (_currentView == 'scope-groups') return ScopeGroupsScreen(user: widget.user);
    
    return Center(child: Text('Module $_currentView not implemented yet.'));
  }

  Widget _buildUserDashboard() {
    final summary = _dashboardSummary;
    final gates = (summary != null && summary['gates'] is List) ? List<dynamic>.from(summary['gates']) : [];
    final totalDevices = summary?['totalDevices'] ?? summary?['totalConfiguredClusters'] ?? gates.where((g) => g['hasMaster'] == true).length;
    final totalUnconfiguredGates = summary?['totalUnconfiguredGates'] ?? gates.where((g) => g['hasMaster'] != true).length;
    final totalCyclesToday = summary?['totalCyclesToday'] ?? 0;
    final totalOpenGates = summary?['totalOpenGates'] ?? 0;
    final totalClosedGates = summary?['totalClosedGates'] ?? 0;
    final roleName = widget.user['role']?.toString() ?? 'User';

    return RefreshIndicator(
      onRefresh: () async {
        await _syncDashboardSummary(forceFullReload: true);
        await _fetchNotifications();
      },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Hero Welcome Banner
            Container(
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF0F172A), Color(0xFF1E293B)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(16),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.12),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  )
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          Text(
                            'Hello, ${widget.user['fullName'] ?? 'User'}',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ],
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: const Color(0xFF0284C7).withOpacity(0.25),
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(color: const Color(0xFF38BDF8).withOpacity(0.4)),
                        ),
                        child: Text(
                          roleName,
                          style: const TextStyle(
                            color: Color(0xFF38BDF8),
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Level Crossing Operations & KPI Dashboard',
                    style: TextStyle(
                      color: Colors.grey.shade400,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 18),

            // 4 KPI Metric Cards in 2x2 Grid
            Row(
              children: [
                Expanded(
                  child: _buildKpiCard(
                    title: 'Active Clusters',
                    value: _loadingSummary ? '-' : '$totalDevices',
                    subtitle: (totalUnconfiguredGates is int && totalUnconfiguredGates > 0)
                        ? '$totalUnconfiguredGates unconfigured'
                        : null,
                    icon: Icons.meeting_room_outlined,
                    iconColor: const Color(0xFF0284C7),
                    iconBg: const Color(0xFFE0F2FE),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _buildKpiCard(
                    title: 'Cycles Today',
                    value: _loadingSummary ? '-' : '$totalCyclesToday',
                    icon: Icons.history,
                    iconColor: const Color(0xFFD97706),
                    iconBg: const Color(0xFFFEF3C7),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _buildKpiCard(
                    title: 'Currently Opened',
                    value: _loadingSummary ? '-' : '$totalOpenGates',
                    icon: Icons.lock_open_rounded,
                    iconColor: const Color(0xFFDC2626),
                    iconBg: const Color(0xFFFEE2E2),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _buildKpiCard(
                    title: 'Currently Closed',
                    value: _loadingSummary ? '-' : '$totalClosedGates',
                    icon: Icons.lock_rounded,
                    iconColor: const Color(0xFF059669),
                    iconBg: const Color(0xFFD1FAE5),
                  ),
                ),
              ],
            ),

            // Live Synchronization & Freshness Status Bar
            Container(
              margin: const EdgeInsets.only(top: 12, bottom: 4),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: BoxDecoration(
                color: const Color(0xFFF8FAFC),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: const Color(0xFFE2E8F0),
                ),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Row(
                    children: [
                      Icon(
                        _isSyncing ? Icons.sync_rounded : Icons.check_circle_outline_rounded,
                        size: 14,
                        color: _isSyncing ? const Color(0xFF0284C7) : const Color(0xFF059669),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        _isSyncing
                            ? 'Synchronizing live gate telemetry...'
                            : 'Verified • Synced ${_formatSyncTime(_lastSyncedAt)}',
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w500,
                          color: Color(0xFF475569),
                        ),
                      ),
                    ],
                  ),
                  InkWell(
                    onTap: _isSyncing ? null : () => _syncDashboardSummary(forceFullReload: true),
                    borderRadius: BorderRadius.circular(4),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                      child: Row(
                        children: [
                          if (_isSyncing)
                            const SizedBox(
                              width: 10,
                              height: 10,
                              child: CircularProgressIndicator(strokeWidth: 1.5, color: Color(0xFF0284C7)),
                            )
                          else
                            const Icon(Icons.refresh, size: 14, color: Color(0xFF0284C7)),
                          const SizedBox(width: 3),
                          const Text(
                            'Sync',
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF0284C7)),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 20),

            // Gate Cycles Transition Slider
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Assigned Gate Cycles',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Daily operations & closure timestamps',
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                    ),
                  ],
                ),
                if (gates.isNotEmpty)
                  Text(
                    '${gates.length} clusters',
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.grey.shade600),
                  ),
              ],
            ),

            const SizedBox(height: 12),

            if (_loadingSummary && gates.isEmpty)
              Container(
                height: 180,
                alignment: Alignment.center,
                child: const CircularProgressIndicator(),
              )
            else if (gates.isEmpty)
              Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.grey.shade200),
                ),
                alignment: Alignment.center,
                child: Column(
                  children: [
                    Icon(Icons.meeting_room_outlined, size: 40, color: Colors.grey.shade400),
                    const SizedBox(height: 8),
                    const Text(
                      'No LC Gates assigned yet',
                      style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Assigned scope group gates will appear here.',
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                    ),
                  ],
                ),
              )
            else
              SizedBox(
                height: 225,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: gates.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 14),
                  itemBuilder: (context, index) {
                    final raw = gates[index];
                    if (raw is! Map) return const SizedBox.shrink();
                    final gate = Map<String, dynamic>.from(raw);
                    final gateId = gate['id'] is int ? gate['id'] as int : int.tryParse(gate['id']?.toString() ?? '') ?? 0;
                    final lcNumber = (gate['hasMaster'] == true && gate['masterSerialNumber'] != null && gate['masterSerialNumber'] != 'Unassigned')
                        ? gate['masterSerialNumber'].toString()
                        : (gate['lcNumber']?.toString() ?? 'LC-GATE');
                    final location = gate['locationName'] ?? '';
                    final zone = gate['zone'] ?? '';
                    final division = gate['division'] ?? '';
                    final isUnconfigured = gate['status'] == 'UNCONFIGURED' || gate['hasMaster'] == false;
                    final isOpen = !isUnconfigured && gate['status'] == 'OPEN';
                    final todayCycles = gate['todayCycles'] ?? 0;
                    final totalCycles = gate['totalCycles'] ?? 0;
                    final lastClosedFormatted = gate['lastClosedFormatted'] ?? 'No recorded closure';
                    final isSolar = gate['powerSource'] == 'SOLAR';
                    final isSelected = _activeGateId == gateId;

                    return InkWell(
                      onTap: () {
                        setState(() => _activeGateId = gateId);
                      },
                      borderRadius: BorderRadius.circular(14),
                      child: Container(
                        width: 295,
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: isSelected ? const Color(0xFFF0F9FF) : Colors.white,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(
                            color: isSelected ? const Color(0xFF0284C7) : Colors.grey.shade200,
                            width: isSelected ? 2 : 1,
                          ),
                          boxShadow: [
                            BoxShadow(
                              color: isSelected
                                  ? const Color(0xFF0284C7).withOpacity(0.12)
                                  : Colors.black.withOpacity(0.03),
                              blurRadius: 8,
                              offset: const Offset(0, 3),
                            )
                          ],
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            // Header Row
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Row(
                                  children: [
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                      decoration: BoxDecoration(
                                        color: const Color(0xFF0F172A),
                                        borderRadius: BorderRadius.circular(6),
                                      ),
                                      child: Text(
                                        lcNumber,
                                        style: const TextStyle(
                                          color: Colors.white,
                                          fontWeight: FontWeight.bold,
                                          fontSize: 12,
                                        ),
                                      ),
                                    ),
                                    if (isSolar) ...[
                                      const SizedBox(width: 6),
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                        decoration: BoxDecoration(
                                          color: Colors.amber.shade50,
                                          borderRadius: BorderRadius.circular(4),
                                        ),
                                        child: Row(
                                          children: [
                                            Icon(Icons.wb_sunny_rounded, size: 10, color: Colors.amber.shade800),
                                            const SizedBox(width: 2),
                                            Text(
                                              'Solar',
                                              style: TextStyle(
                                                fontSize: 10,
                                                fontWeight: FontWeight.bold,
                                                color: Colors.amber.shade800,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                  decoration: BoxDecoration(
                                    color: isUnconfigured
                                        ? const Color(0xFFFEF3C7)
                                        : (isOpen ? const Color(0xFFFEE2E2) : const Color(0xFFD1FAE5)),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(
                                      color: isUnconfigured
                                          ? const Color(0xFFFDE68A)
                                          : (isOpen ? const Color(0xFFFECACA) : const Color(0xFFA7F3D0)),
                                    ),
                                  ),
                                  child: Text(
                                    isUnconfigured ? '● UNCONFIGURED' : (isOpen ? '● OPEN' : '● CLOSED'),
                                    style: TextStyle(
                                      color: isUnconfigured
                                          ? const Color(0xFFD97706)
                                          : (isOpen ? const Color(0xFFDC2626) : const Color(0xFF059669)),
                                      fontSize: 10,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                ),
                              ],
                            ),

                            // Location
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  location,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 13,
                                    color: Color(0xFF0F172A),
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                Text(
                                  '$zone • $division Division',
                                  style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ),

                            // Metric Box
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                              decoration: BoxDecoration(
                                color: isSelected ? Colors.white : Colors.grey.shade50,
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(color: Colors.grey.shade200),
                              ),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Row(
                                    children: [
                                      const Icon(Icons.history, color: Color(0xFF0284C7), size: 18),
                                      const SizedBox(width: 8),
                                      Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          const Text(
                                            'CYCLES TODAY',
                                            style: TextStyle(
                                              fontSize: 9,
                                              fontWeight: FontWeight.bold,
                                              color: Colors.grey,
                                            ),
                                          ),
                                          Text(
                                            '$todayCycles times',
                                            style: const TextStyle(
                                              fontSize: 13,
                                              fontWeight: FontWeight.bold,
                                              color: Color(0xFF0F172A),
                                            ),
                                          ),
                                        ],
                                      ),
                                    ],
                                  ),
                                  Text(
                                    'Total: $totalCycles',
                                    style: TextStyle(fontSize: 10.5, color: Colors.grey.shade600),
                                  ),
                                ],
                              ),
                            ),

                            // Last Closed Time
                            Row(
                              children: [
                                Icon(Icons.schedule, size: 13, color: Colors.grey.shade500),
                                const SizedBox(width: 4),
                                Expanded(
                                  child: Text(
                                    'Last Closed: $lastClosedFormatted',
                                    style: TextStyle(
                                      fontSize: 11,
                                      color: Colors.grey.shade700,
                                      fontWeight: FontWeight.w500,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ),

                            // Action Buttons
                            Row(
                              children: [
                                Expanded(
                                  child: ElevatedButton(
                                    onPressed: () => _navigateToGate(gateId, 'telemetry'),
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: const Color(0xFF0284C7),
                                      foregroundColor: Colors.white,
                                      padding: const EdgeInsets.symmetric(vertical: 6),
                                      minimumSize: Size.zero,
                                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                    ),
                                    child: const Text('Telemetry', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: OutlinedButton(
                                    onPressed: () => _navigateToGate(gateId, 'about'),
                                    style: OutlinedButton.styleFrom(
                                      padding: const EdgeInsets.symmetric(vertical: 6),
                                      minimumSize: Size.zero,
                                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                      side: BorderSide(color: Colors.grey.shade300),
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                    ),
                                    child: const Text('About', style: TextStyle(fontSize: 11, color: Color(0xFF334155), fontWeight: FontWeight.w600)),
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
              ),

            const SizedBox(height: 24),

            // India LC Gate Clusters Map Card (Dedicated Entry Point)
            Container(
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.grey.shade200),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.03),
                    blurRadius: 10,
                    offset: const Offset(0, 3),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.all(8),
                            decoration: BoxDecoration(
                              color: const Color(0xFFE0F2FE),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: const Icon(Icons.map_rounded, color: Color(0xFF0284C7), size: 20),
                          ),
                          const SizedBox(width: 10),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'India LC Gate Clusters Map',
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.bold,
                                  color: Color(0xFF0F172A),
                                ),
                              ),
                              Text(
                                '${gates.length} assigned railway clusters',
                                style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600),
                              ),
                            ],
                          ),
                        ],
                      ),
                      Row(
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: const BoxDecoration(
                              color: Color(0xFF059669),
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 4),
                          Text('$totalClosedGates', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF059669))),
                          const SizedBox(width: 8),
                          Container(
                            width: 8,
                            height: 8,
                            decoration: const BoxDecoration(
                              color: Color(0xFFDC2626),
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 4),
                          Text('$totalOpenGates', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFFDC2626))),
                        ],
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'Interactive full-screen geospatial visualization showing real-time operational status, GPS coordinates, and barrier telemetry across India.',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade600, height: 1.4),
                  ),
                  const SizedBox(height: 16),
                  ElevatedButton.icon(
                    onPressed: () async {
                      final token = await _getToken();
                      if (!mounted) return;
                      Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => FullScreenMapScreen(
                            user: widget.user,
                            token: token,
                            initialGates: gates,
                            onNavigateToGate: _navigateToGate,
                          ),
                        ),
                      );
                    },
                    icon: const Icon(Icons.explore_outlined, size: 18),
                    label: const Text('View All Gates on Map', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF0F172A),
                      foregroundColor: Colors.white,
                      minimumSize: const Size(double.infinity, 44),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                      elevation: 0,
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }

  Widget _buildKpiCard({
    required String title,
    required String value,
    String? subtitle,
    required IconData icon,
    required Color iconColor,
    required Color iconBg,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.grey.shade200),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.02),
            blurRadius: 6,
            offset: const Offset(0, 2),
          )
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                title.toUpperCase(),
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                  color: Colors.grey.shade600,
                  letterSpacing: 0.5,
                ),
              ),
              Container(
                padding: const EdgeInsets.all(6),
                decoration: BoxDecoration(
                  color: iconBg,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(icon, color: iconColor, size: 16),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            value,
            style: const TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.bold,
              color: Color(0xFF0F172A),
            ),
          ),
          if (subtitle != null && subtitle.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(
              subtitle,
              style: TextStyle(fontSize: 10.5, color: Colors.grey.shade500),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildAdminDashboard() {
    return DefaultTabController(
      length: 2,
      child: Column(
        children: [
          TabBar(
            labelColor: AppColors.primary,
            tabs: [
              const Tab(text: 'Existing Users'),
              Tab(text: 'Pending Approval (${_pendingRequests.length})'),
            ]
          ),
          Expanded(
            child: TabBarView(
              children: [
                _buildExistingUsersTab(),
                _buildPendingUsersTab(_pendingRequests),
              ]
            )
          )
        ],
      ),
    );
  }

  Widget _buildPendingUsersTab(List<dynamic> pending) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    if (pending.isEmpty) return const Center(child: Text('No pending requests.'));
    
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: pending.length,
      itemBuilder: (c, i) {
        final req = pending[i];
        final reqData = json.decode(req['data'] ?? '{}');
        final form = req['form'] is Map ? Map<String, dynamic>.from(req['form'] as Map) : null;

        // Resolve requested role ID and role name from request or form data
        int? reqRoleId = req['requestedRoleId'];
        if (reqRoleId == null && reqData is Map) {
          if (reqData['roleId'] != null) {
            reqRoleId = int.tryParse(reqData['roleId'].toString());
          } else if (reqData['requestedRoleId'] != null) {
            reqRoleId = int.tryParse(reqData['requestedRoleId'].toString());
          }
        }

        String? reqRoleName = req['requestedRoleName'];
        if (reqRoleName == null && reqRoleId != null) {
          final found = _roles.firstWhere(
            (r) => r['id'] == reqRoleId,
            orElse: () => null,
          );
          if (found != null) {
            reqRoleName = found['name'];
          }
        }

        // Determine currently selected role: use tracked selection, or default to requested role, or first role
        int? selectedRole = _pendingRoleSelections[req['id']];
        if (selectedRole == null || !_roles.any((r) => r['id'] == selectedRole)) {
          if (reqRoleId != null && _roles.any((r) => r['id'] == reqRoleId)) {
            selectedRole = reqRoleId;
          } else if (_roles.isNotEmpty) {
            selectedRole = _roles[0]['id'];
          }
          if (selectedRole != null) {
            _pendingRoleSelections[req['id']] = selectedRole;
          }
        }

        // Find best display name for user
        String displayName = reqData['fullName'] ?? '';
        if (displayName.isEmpty) {
          for (var entry in reqData.entries) {
            final info = _resolveFieldInfo(form, entry.key);
            if (info['label'].toString().toLowerCase().contains('name') && entry.value.toString().isNotEmpty) {
              displayName = entry.value.toString();
              break;
            }
          }
        }
        if (displayName.isEmpty) displayName = 'Pending User';
        
        return Card(
          elevation: 2,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          color: Colors.white,
          margin: const EdgeInsets.only(bottom: 16),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(displayName, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18, color: AppColors.primary)),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(color: Colors.orange.shade100, borderRadius: BorderRadius.circular(16)),
                      child: Text('PENDING', style: TextStyle(color: Colors.orange.shade900, fontSize: 10, fontWeight: FontWeight.bold)),
                    ),
                  ],
                ),
                if (form != null && form['name'] != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text('Form: ${form['name']}', style: TextStyle(fontSize: 12, color: Colors.grey.shade600, fontStyle: FontStyle.italic)),
                  ),
                if (req['hasConflict'] == true) ...[
                  Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(top: 10, bottom: 2),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFEE2E2),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: const Color(0xFFFCA5A5)),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.warning_amber_rounded, size: 18, color: Color(0xFFB91C1C)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Conflict: ${((req['conflictReasons'] as List?) ?? []).join(" • ")}',
                            style: const TextStyle(color: Color(0xFFB91C1C), fontSize: 12, fontWeight: FontWeight.bold),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const Divider(height: 24),
                ...reqData.entries.where((e) {
                  final kLower = e.key.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
                  if (kLower.contains('password')) return false;
                  // Skip raw role ID fields from being dumped as generic attributes
                  if (kLower == 'roleid' || kLower == 'requestedroleid' || kLower == 'role') return false;
                  return true;
                }).map((e) {
                  final fieldInfo = _resolveFieldInfo(form, e.key);
                  final label = fieldInfo['label'] ?? e.key;
                  final isImg = _isImageUrl(e.value, fieldInfo['type']);

                  return Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(flex: 2, child: Text(label, style: TextStyle(color: Colors.grey.shade700, fontSize: 13, fontWeight: FontWeight.w600))),
                        Expanded(
                          flex: 3, 
                          child: isImg
                              ? Align(alignment: Alignment.centerLeft, child: _buildImageThumbnail(e.value.toString(), label))
                              : Text(e.value.toString(), style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                        ),
                      ],
                    ),
                  );
                }),
                const SizedBox(height: 8),
                if (reqRoleId != null || reqRoleName != null) ...[
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    decoration: BoxDecoration(
                      color: const Color(0xFFEFF6FF),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: const Color(0xFFBFDBFE)),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.verified_user_outlined, size: 18, color: Color(0xFF1D4ED8)),
                        const SizedBox(width: 8),
                        Text(
                          'Requested Role: ',
                          style: TextStyle(fontSize: 13, color: Colors.grey.shade700, fontWeight: FontWeight.w600),
                        ),
                        Expanded(
                          child: Text(
                            reqRoleName ?? 'Role #$reqRoleId',
                            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8)),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                ],
                DropdownButtonFormField<int>(
                  value: selectedRole,
                  decoration: InputDecoration(
                    labelText: 'Assign Role',
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8)
                  ),
                  items: _roles.map((e) => DropdownMenuItem<int>(
                    value: e['id'], 
                    child: Text('${e['name']}${e['id'] == reqRoleId ? ' (Requested)' : ''}'),
                  )).toList(),
                  onChanged: (v) {
                    if (v != null) {
                      setState(() {
                        _pendingRoleSelections[req['id']] = v;
                      });
                    }
                  },
                ),
                const SizedBox(height: 20),
                Row(
                  children: [
                    Expanded(child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: req['hasConflict'] == true ? Colors.grey : AppColors.success, 
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)), 
                        padding: const EdgeInsets.symmetric(vertical: 12)
                      ),
                      onPressed: () {
                        if (req['hasConflict'] == true) {
                          final reasons = ((req['conflictReasons'] as List?) ?? []).join('; ');
                          AppFeedback.showError(
                            context,
                            'Cannot approve: $reasons. Please reject this request or resolve the duplicate user first.',
                          );
                          return;
                        }
                        String assignedRoleName = 'Selected Role';
                        final matchedRole = _roles.firstWhere((r) => r['id'] == selectedRole, orElse: () => null);
                        if (matchedRole != null && matchedRole['name'] != null) {
                          assignedRoleName = matchedRole['name'];
                        }
                        _actionUser(req['id'], 'approve', {'roleId': selectedRole}, true, displayName, assignedRoleName);
                      },
                      child: const Text('Approve', style: TextStyle(fontWeight: FontWeight.bold)),
                    )),
                    const SizedBox(width: 12),
                    Expanded(child: OutlinedButton(
                      style: OutlinedButton.styleFrom(foregroundColor: AppColors.danger, side: const BorderSide(color: AppColors.danger), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)), padding: const EdgeInsets.symmetric(vertical: 12)),
                      onPressed: () => _actionUser(req['id'], 'reject', {'reason': 'Rejected by admin'}, true, displayName),
                      child: const Text('Reject', style: TextStyle(fontWeight: FontWeight.bold)),
                    )),
                  ],
                ),
              ],
            ),
          )
        );
      }
    );
  }

  Map<String, dynamic> _resolveFieldInfo(Map<String, dynamic>? form, String key) {
    if (form != null && form['schema'] != null) {
      try {
        final schemaRaw = form['schema'];
        final schema = schemaRaw is String ? json.decode(schemaRaw) : schemaRaw;
        final fields = schema is Map ? (schema['fields'] as List? ?? []) : (schema is List ? schema : []);
        
        Map<String, dynamic>? findInList(List<dynamic> list) {
          for (var item in list) {
            if (item is Map) {
              if (item['type'] == 'section' && item['children'] is List) {
                final found = findInList(item['children']);
                if (found != null) return found;
              } else if (item['name'] == key || item['id'] == key) {
                return Map<String, dynamic>.from(item);
              }
            }
          }
          return null;
        }

        final match = findInList(fields);
        if (match != null && match['label'] != null && match['label'].toString().trim().isNotEmpty) {
          return {
            'label': match['label'].toString(),
            'type': match['type']?.toString() ?? 'text'
          };
        }
      } catch (_) {}
    }

    return {'label': _humanizeKey(key), 'type': 'text'};
  }

  String _humanizeKey(String key) {
    final cleanKey = key.trim();
    final normalized = cleanKey.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
    if (normalized == 'fullname' || normalized == 'name' || normalized == 'applicantname') return 'Full Name';
    if (normalized == 'mobile' || normalized == 'phone' || normalized == 'mobilenumber' || normalized == 'phonenumber') return 'Mobile Number';
    if (normalized == 'email' || normalized == 'emailaddress') return 'Email Address';
    if (normalized == 'employeeid' || normalized == 'empid') return 'Employee ID';
    if (normalized == 'department' || normalized == 'dept') return 'Department';
    if (normalized == 'gender') return 'Gender';
    if (normalized == 'roleid') return 'Requested Role ID';
    if (cleanKey.startsWith('field_')) {
      final sub = cleanKey.substring(6);
      return sub.length > 6 ? 'Custom Field (${sub.substring(sub.length - 4)})' : 'Custom Field ($sub)';
    }
    final spaced = cleanKey.replaceAllMapped(RegExp(r'([A-Z])'), (m) => ' ${m[0]}').replaceAll('_', ' ').trim();
    if (spaced.isEmpty) return key;
    return spaced[0].toUpperCase() + spaced.substring(1);
  }

  bool _isImageUrl(dynamic val, String? type) {
    if (val == null) return false;
    final str = val.toString().trim();
    if (type == 'image') return true;
    if (str.startsWith('http://') || str.startsWith('https://')) {
      final lower = str.toLowerCase();
      if (lower.contains('/image/upload/') || lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp') || lower.endsWith('.gif')) {
        return true;
      }
    }
    return false;
  }

  Widget _buildImageThumbnail(String url, String label) {
    return InkWell(
      onTap: () {
        showDialog(
          context: context,
          builder: (ctx) => Dialog(
            backgroundColor: Colors.transparent,
            insetPadding: const EdgeInsets.all(16),
            child: Stack(
              alignment: Alignment.topRight,
              children: [
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(label, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                      const SizedBox(height: 12),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: Image.network(
                          url,
                          fit: BoxFit.contain,
                          loadingBuilder: (c, child, p) => p == null ? child : const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
                          errorBuilder: (c, e, s) => const Padding(padding: EdgeInsets.all(24), child: Text('Failed to load image')),
                        ),
                      ),
                    ],
                  ),
                ),
                Positioned(
                  top: 4,
                  right: 4,
                  child: IconButton(
                    icon: const CircleAvatar(backgroundColor: Colors.black54, radius: 14, child: Icon(Icons.close, color: Colors.white, size: 16)),
                    onPressed: () => Navigator.pop(ctx),
                  ),
                ),
              ],
            ),
          ),
        );
      },
      child: Container(
        height: 60,
        width: 90,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Colors.grey.shade300),
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          alignment: Alignment.center,
          children: [
            Image.network(
              url,
              fit: BoxFit.cover,
              width: double.infinity,
              height: double.infinity,
              errorBuilder: (context, error, stackTrace) => const Center(child: Icon(Icons.broken_image, size: 20, color: Colors.grey)),
            ),
            Positioned(
              bottom: 2,
              right: 2,
              child: Container(
                padding: const EdgeInsets.all(2),
                decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(4)),
                child: const Icon(Icons.zoom_in, color: Colors.white, size: 12),
              ),
            )
          ],
        ),
      ),
    );
  }

  String? _expandedRole;

  Widget _buildStatusFilterChip(String status, String label) {
    final isSelected = _userStatusFilter == status;
    return ChoiceChip(
      label: Text(
        label,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: isSelected ? FontWeight.bold : FontWeight.w500,
          color: isSelected ? Colors.white : Colors.grey.shade700,
        ),
      ),
      selected: isSelected,
      selectedColor: AppColors.primary,
      backgroundColor: Colors.grey.shade100,
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: isSelected ? AppColors.primary : Colors.grey.shade300),
      ),
      onSelected: (_) {
        setState(() => _userStatusFilter = status);
      },
    );
  }

  Widget _buildExistingUsersTab() {
    if (_isLoading) return const Center(child: CircularProgressIndicator());

    // Filter users based on search query and status filter
    final filteredUsers = _users.where((u) {
      if (u['status'] == 'PENDING') return false;

      // Status filter
      if (_userStatusFilter != 'ALL' && u['status'] != _userStatusFilter) {
        return false;
      }

      // Search query
      if (_userSearchQuery.trim().isNotEmpty) {
        final q = _userSearchQuery.trim().toLowerCase();
        final name = (u['fullName'] ?? '').toString().toLowerCase();
        final empId = (u['employeeId'] ?? '').toString().toLowerCase();
        final dept = (u['department'] ?? '').toString().toLowerCase();
        final email = (u['email'] ?? '').toString().toLowerCase();
        final mobile = (u['mobile'] ?? '').toString().toLowerCase();
        final role = (u['role']?['name'] ?? '').toString().toLowerCase();

        final matches = name.contains(q) ||
            empId.contains(q) ||
            dept.contains(q) ||
            email.contains(q) ||
            mobile.contains(q) ||
            role.contains(q);

        if (!matches) return false;
      }

      return true;
    }).toList();
    
    final Map<String, List<dynamic>> grouped = {};
    for (var u in filteredUsers) {
      final rn = u['role']?['name'] ?? 'Unknown';
      if (!grouped.containsKey(rn)) grouped[rn] = [];
      grouped[rn]!.add(u);
    }
    
    return Column(
      children: [
        // Search & Filter Header
        Container(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          color: Colors.white,
          child: Column(
            children: [
              // Search Input Field
              TextField(
                controller: _userSearchCtrl,
                onChanged: (val) {
                  setState(() => _userSearchQuery = val);
                },
                decoration: InputDecoration(
                  hintText: 'Search by name, ID, email, or dept...',
                  hintStyle: TextStyle(fontSize: 13, color: Colors.grey.shade500),
                  prefixIcon: const Icon(Icons.search, size: 20, color: AppColors.primary),
                  suffixIcon: _userSearchQuery.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear, size: 18),
                          onPressed: () {
                            _userSearchCtrl.clear();
                            setState(() => _userSearchQuery = '');
                          },
                        )
                      : null,
                  filled: true,
                  fillColor: Colors.grey.shade50,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: BorderSide(color: Colors.grey.shade300),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: BorderSide(color: Colors.grey.shade300),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: const BorderSide(color: AppColors.primary, width: 1.5),
                  ),
                ),
              ),
              const SizedBox(height: 10),

              // Filter Chips Row
              Row(
                children: [
                  const Text('Status: ', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.grey)),
                  const SizedBox(width: 4),
                  Wrap(
                    spacing: 6,
                    children: [
                      _buildStatusFilterChip('ALL', 'All (${_users.where((u) => u['status'] != 'PENDING').length})'),
                      _buildStatusFilterChip('APPROVED', 'Active'),
                      _buildStatusFilterChip('DEACTIVATED', 'Deactivated'),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ),
        const Divider(height: 1),

        // List Content
        Expanded(
          child: grouped.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.search_off_rounded, size: 48, color: Colors.grey.shade400),
                        const SizedBox(height: 12),
                        Text(
                          'No users match your filters',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Colors.grey.shade700),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          'Try searching with a different keyword or reset filters.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 13, color: Colors.grey.shade500),
                        ),
                        if (_userSearchQuery.isNotEmpty || _userStatusFilter != 'ALL') ...[
                          const SizedBox(height: 16),
                          OutlinedButton.icon(
                            icon: const Icon(Icons.refresh, size: 16),
                            label: const Text('Reset Filters'),
                            onPressed: () {
                              _userSearchCtrl.clear();
                              setState(() {
                                _userSearchQuery = '';
                                _userStatusFilter = 'ALL';
                              });
                              AppFeedback.showInfo(context, 'User search and status filters cleared.');
                            },
                          ),
                        ],
                      ],
                    ),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: grouped.entries.map((e) {
                    final isExpanded = _expandedRole == e.key;
                    return Card(
                      margin: const EdgeInsets.only(bottom: 8),
                      child: Column(
                        children: [
                          ListTile(
                onTap: () {
                  setState(() {
                    _expandedRole = isExpanded ? null : e.key;
                  });
                },
                leading: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(color: AppColors.secondary, borderRadius: BorderRadius.circular(16)),
                  child: Text('${e.value.length}', style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold)),
                ),
                title: Text(e.key, style: const TextStyle(fontWeight: FontWeight.bold)),
                trailing: Icon(isExpanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down),
              ),
              if (isExpanded)
                Container(
                  color: Colors.grey[50],
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    children: e.value.map((u) {
                      Map<String, dynamic> metadata = {};
                      try {
                        if (u['metadata'] != null) {
                          metadata = json.decode(u['metadata']);
                        }
                      } catch (_) {}
                      
                      List<Widget> metaWidgets = [];
                      final seenKeys = <String>{
                        'fullname', 'name', 'applicantname',
                        'employeeid', 'empid',
                        'department', 'dept',
                        'role', 'roleid', 'status', 'password', 'id'
                      };
                      final seenVals = <String>{};

                      void addMetaRow(String label, dynamic val) {
                        if (val == null) return;
                        final sVal = val.toString().trim();
                        if (sVal.isEmpty) return;
                        final normKey = label.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
                        if (seenKeys.contains(normKey)) return;
                        if (seenVals.contains(sVal.toLowerCase())) return;

                        seenKeys.add(normKey);
                        final isImg = _isImageUrl(val, null);
                        if (!isImg) seenVals.add(sVal.toLowerCase());

                        metaWidgets.add(
                          Padding(
                            padding: const EdgeInsets.only(bottom: 6),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Expanded(flex: 2, child: Text(label, style: const TextStyle(color: Colors.grey, fontSize: 12, fontWeight: FontWeight.w500))),
                                Expanded(
                                  flex: 3, 
                                  child: isImg
                                      ? Align(alignment: Alignment.centerLeft, child: _buildImageThumbnail(sVal, label))
                                      : Text(sVal, style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 12)),
                                ),
                              ],
                            ),
                          ),
                        );
                      }

                      if (u['mobile'] != null && u['mobile'].toString().trim().isNotEmpty) {
                        addMetaRow('Mobile Number', u['mobile']);
                      }
                      if (u['email'] != null && u['email'].toString().trim().isNotEmpty) {
                        addMetaRow('Email Address', u['email']);
                      }

                      metadata.forEach((k, v) {
                        if (k.toLowerCase().contains('password')) return;
                        final normK = k.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
                        if (seenKeys.contains(normK)) return;
                        final displayKey = _humanizeKey(k);
                        final normDisplay = displayKey.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
                        if (seenKeys.contains(normDisplay)) return;
                        addMetaRow(displayKey, v);
                      });

                      return Card(
                        elevation: 0,
                        margin: const EdgeInsets.only(bottom: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8),
                          side: BorderSide(color: Colors.grey.shade300)
                        ),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(u['fullName'] ?? 'Unknown', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                                        Text('${u['employeeId']} | ${u['department']}', style: const TextStyle(color: Colors.grey, fontSize: 13)),
                                      ],
                                    ),
                                  ),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                    decoration: BoxDecoration(color: u['status'] == 'APPROVED' ? AppColors.success : Colors.grey, borderRadius: BorderRadius.circular(16)),
                                    child: Text(u['status'], style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold)),
                                  ),
                                ],
                              ),
                              if (metaWidgets.isNotEmpty) ...[
                                const Divider(height: 24),
                                ...metaWidgets
                              ],
                              const SizedBox(height: 12),
                              Align(
                                alignment: Alignment.centerRight,
                                child: TextButton.icon(
                                  style: TextButton.styleFrom(foregroundColor: u['status'] == 'DEACTIVATED' ? AppColors.success : AppColors.danger),
                                  icon: Icon(u['status'] == 'DEACTIVATED' ? Icons.check_circle : Icons.block, size: 18),
                                  label: Text(u['status'] == 'DEACTIVATED' ? 'Reactivate User' : 'Deactivate User'),
                                  onPressed: () async {
                                    final isDeactivated = u['status'] == 'DEACTIVATED';
                                    final actionName = isDeactivated ? 'reactivate' : 'deactivate';
                                    final userName = (u['fullName'] ?? 'User').toString();
                                    
                                    final confirm = await showDialog<bool>(
                                      context: context,
                                      builder: (context) => AlertDialog(
                                        title: Text('Confirm ${isDeactivated ? 'Reactivation' : 'Deactivation'}'),
                                        content: Text('Are you sure you want to $actionName user "$userName"?'),
                                        actions: [
                                          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
                                          ElevatedButton(
                                            onPressed: () => Navigator.pop(context, true),
                                            style: ElevatedButton.styleFrom(backgroundColor: isDeactivated ? AppColors.success : AppColors.danger),
                                            child: const Text('Confirm', style: TextStyle(color: Colors.white)),
                                          ),
                                        ],
                                      ),
                                    );
                                    if (confirm == true) {
                                      _actionUser(u['id'], actionName, null, false, userName);
                                    }
                                  },
                                ),
                              ),
                            ],
                          ),
                        ),
                      );
                    }).toList(),
                  ),
                ),
            ],
          ),
        );
      }).toList(),
    ),
  ),
],
);
}
}



