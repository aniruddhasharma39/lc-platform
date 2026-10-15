import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import '../cluster/railway_data.dart';
import 'create_edit_scope_group_screen.dart';

Color parseHexColor(String? hexString) {
  if (hexString == null || hexString.isEmpty) return const Color(0xFF0B3C7A);
  try {
    final hex = hexString.replaceAll('#', '');
    return Color(int.parse('FF$hex', radix: 16));
  } catch (_) {
    return const Color(0xFF0B3C7A);
  }
}

class ScopeGroupsScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  const ScopeGroupsScreen({super.key, required this.user});

  @override
  State<ScopeGroupsScreen> createState() => _ScopeGroupsScreenState();
}

class _ScopeGroupsScreenState extends State<ScopeGroupsScreen> {
  List<dynamic> _scopeGroups = [];
  bool _isLoading = true;
  String _token = '';
  String _searchQuery = '';

  bool _isDeveloper = false;
  bool _hasAssignedScopes = false;

  // Folder UI state: tracks which groups/folders are expanded
  final Set<int> _expandedGroupIds = {};
  final Set<int> _expandedChildIds = {};

  bool get _canManage => _isDeveloper && !_hasAssignedScopes;

  @override
  void initState() {
    super.initState();
    final role = widget.user['role']?.toString();
    final userScopes = widget.user['scopeGroups'];
    _isDeveloper = role == 'Developer';
    _hasAssignedScopes = (userScopes is List && userScopes.isNotEmpty);

    _loadTokenAndFetch();
  }

  Future<void> _loadTokenAndFetch() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token') ?? '';
    if (!mounted) return;
    setState(() => _token = token);
    await _fetchScopeGroups();
  }

  Future<void> _fetchScopeGroups({bool isManual = false}) async {
    if (!isManual) setState(() => _isLoading = true);
    try {
      // 1. Fetch live permission & assigned status from /my-scope
      try {
        final myScopeRes = await http.get(
          Uri.parse('$baseUrl/scope-groups/my-scope'),
          headers: {'Authorization': 'Bearer $_token'},
        );
        if (myScopeRes.statusCode == 200) {
          final myScopeData = json.decode(myScopeRes.body);
          if (myScopeData is Map) {
            _hasAssignedScopes = myScopeData['hasAssignedScopes'] == true;
            _isDeveloper = myScopeData['isDeveloper'] == true;
          }
        }
      } catch (_) {}

      // 2. Fetch accessible scope groups
      final res = await http.get(
        Uri.parse('$baseUrl/scope-groups'),
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _scopeGroups = data is List ? data : [];
            _isLoading = false;
          });
          if (isManual) {
            AppFeedback.showSuccess(context, 'Scope groups catalog refreshed.');
          }
        }
      } else {
        if (mounted) {
          setState(() => _isLoading = false);
          AppFeedback.showError(
            context,
            'Failed to load scope groups (HTTP ${res.statusCode}).',
          );
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() => _isLoading = false);
        AppFeedback.showError(context, 'Error loading scope groups: $e');
      }
    }
  }

  void _navigateToCreate({int? preselectedParentId}) async {
    final result = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CreateEditScopeGroupScreen(
          token: _token,
          preselectedParentId: preselectedParentId,
          existingScopeGroups: _scopeGroups,
        ),
      ),
    );
    if (!mounted) return;
    if (result == true) {
      _fetchScopeGroups();
    }
  }

  void _navigateToEdit(Map<String, dynamic> group) async {
    final result = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CreateEditScopeGroupScreen(
          group: group,
          token: _token,
          existingScopeGroups: _scopeGroups,
        ),
      ),
    );
    if (!mounted) return;
    if (result == true) {
      _fetchScopeGroups();
    }
  }

  void _confirmDeleteGroup(Map<String, dynamic> group) {
    final groupName = (group['name'] ?? 'Scope Group').toString();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Delete Scope Group "$groupName"?'),
        content: Text(
          'Are you sure you want to delete "$groupName"? Any nested sub-groups, gate, and user assignments will be unlinked.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.danger,
              foregroundColor: Colors.white,
            ),
            onPressed: () async {
              Navigator.pop(ctx);
              await _deleteGroup(group['id'], groupName);
            },
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }

  Future<void> _deleteGroup(dynamic id, String groupName) async {
    setState(() => _isLoading = true);
    try {
      final res = await http.delete(
        Uri.parse('$baseUrl/scope-groups/$id'),
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (res.statusCode == 200 || res.statusCode == 204) {
        if (!mounted) return;
        AppFeedback.showSuccess(context, 'Scope group "$groupName" deleted successfully.');
        _fetchScopeGroups();
      } else {
        String err = 'Failed to delete scope group';
        try {
          final data = json.decode(res.body);
          if (data['error'] != null) err = data['error'];
        } catch (_) {}
        if (!mounted) return;
        setState(() => _isLoading = false);
        AppFeedback.showError(context, err);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _isLoading = false);
      AppFeedback.showError(context, 'Network error deleting scope group: $e');
    }
  }

  void _navigateToGroupDetail(Map<String, dynamic> group) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => ScopeGroupDetailPage(
          group: group,
          allScopeGroups: _scopeGroups,
          token: _token,
          canManage: _canManage,
          onRefreshRequested: _fetchScopeGroups,
        ),
      ),
    ).then((_) {
      if (mounted) _fetchScopeGroups();
    });
  }

  // --- Railway Zone & Division Hierarchy Resolution Helpers ---

  /// Determines if a group is a child Division/Subgroup under a Zone
  bool _isDivisionOrSubGroup(Map<String, dynamic> group) {
    final pid = group['parentId'];
    if (pid != null && _scopeGroups.any((g) => g['id'] == pid)) {
      return true;
    }

    // Smart Railway Zone & Division inference:
    // If a group name indicates it is a Division (or matches RailwayData divisions)
    // and there exists another group in the list that is a Railway Zone, it belongs under that Zone!
    final gName = (group['name'] ?? '').toString().toLowerCase();
    for (final potentialParent in _scopeGroups) {
      if (potentialParent['id'] == group['id']) continue;
      final pName = (potentialParent['name'] ?? '').toString().toLowerCase();
      final isZone = pName.contains('railway') || RailwayData.zones.any((z) => pName.contains(z.toLowerCase()));

      if (isZone) {
        final zoneDivisions = RailwayData.divisionsForZone(potentialParent['name']);
        final matchesDivision = zoneDivisions.any((d) => gName.contains(d.toLowerCase())) ||
            gName.contains('division') ||
            gName.contains('section');
        if (matchesDivision) {
          return true;
        }
      }
    }
    return false;
  }

  /// Top-level Railway Zones (or root groups with no parent).
  /// Divisions are nested under the Zone and will NEVER appear at the top level at the same time!
  List<dynamic> get _rootGroups {
    return _scopeGroups.where((g) {
      return !_isDivisionOrSubGroup(g as Map<String, dynamic>);
    }).toList();
  }

  /// Finds the effective parent for a group (either explicit parentId or smart zone match)
  Map<String, dynamic>? _resolveParent(Map<String, dynamic> group) {
    if (group['parent'] is Map) {
      return group['parent'] as Map<String, dynamic>;
    }
    final pid = group['parentId'];
    if (pid != null) {
      final found = _scopeGroups.firstWhere((g) => g['id'] == pid, orElse: () => null);
      if (found != null) return found as Map<String, dynamic>;
    }

    // Fallback: check if this group is a division belonging to a railway zone in _scopeGroups
    final gName = (group['name'] ?? '').toString().toLowerCase();
    for (final zoneGroup in _scopeGroups) {
      if (zoneGroup['id'] == group['id']) continue;
      final zoneName = (zoneGroup['name'] ?? '').toString().toLowerCase();
      final isZone = zoneName.contains('railway') || RailwayData.zones.any((z) => zoneName.contains(z.toLowerCase()));
      if (isZone) {
        final zoneDivisions = RailwayData.divisionsForZone(zoneGroup['name']);
        if (zoneDivisions.any((d) => gName.contains(d.toLowerCase())) || gName.contains('division')) {
          return zoneGroup as Map<String, dynamic>;
        }
      }
    }
    return null;
  }

  /// Direct children of a group (divisions under zone, or sub-units under division)
  List<dynamic> _getDirectChildren(int parentId) {
    final parent = _scopeGroups.firstWhere((g) => g['id'] == parentId, orElse: () => null);
    if (parent == null) return [];
    final parentName = (parent['name'] ?? '').toString().toLowerCase();
    final isZone = parentName.contains('railway') || RailwayData.zones.any((z) => parentName.contains(z.toLowerCase()));
    final zoneDivisions = isZone ? RailwayData.divisionsForZone(parent['name']) : <String>[];

    return _scopeGroups.where((g) {
      if (g['id'] == parentId) return false;
      // 1. Explicit parentId match
      if (g['parentId'] == parentId) return true;

      // 2. Fallback: if parentId is null, and parent is a Zone, check if child is a Division for this Zone
      if (g['parentId'] == null && isZone) {
        final gName = (g['name'] ?? '').toString().toLowerCase();
        if (zoneDivisions.any((d) => gName.contains(d.toLowerCase()))) {
          return true;
        }
        // If it explicitly says "Division" and this is the matching zone
        if (gName.contains('division')) {
          final otherZones = _scopeGroups.where((z) =>
              z['id'] != parentId && (z['name'] ?? '').toString().toLowerCase().contains('railway'));
          if (otherZones.isEmpty) return true;
        }
      }
      return false;
    }).toList();
  }

  /// Recursively collect all unique gates across a group and all its descendant divisions
  List<dynamic> _getRecursiveGates(int groupId) {
    final descendantIds = <int>{groupId};
    final queue = [groupId];
    while (queue.isNotEmpty) {
      final curr = queue.removeAt(0);
      final children = _getDirectChildren(curr);
      for (final c in children) {
        final cid = c['id'] as int?;
        if (cid != null && !descendantIds.contains(cid)) {
          descendantIds.add(cid);
          queue.add(cid);
        }
      }
    }

    final gateMap = <dynamic, dynamic>{};
    for (final g in _scopeGroups) {
      if (descendantIds.contains(g['id'])) {
        final gates = (g['gates'] as List?) ?? [];
        for (final item in gates) {
          final gate = item['gate'] ?? item;
          final gid = gate['id'];
          if (gid != null && !gateMap.containsKey(gid)) {
            gateMap[gid] = gate;
          }
        }
      }
    }
    return gateMap.values.toList();
  }

  List<dynamic> get _displayedGroups {
    final q = _searchQuery.toLowerCase().trim();
    if (q.isEmpty) {
      // By default, ONLY display top-level Railway Zones.
      // Divisions are neatly nested under their respective zone!
      return _rootGroups;
    }
    // When searching, search across all levels and show matching items with zone trail
    return _scopeGroups.where((g) {
      final name = (g['name'] ?? '').toString().toLowerCase();
      final desc = (g['description'] ?? '').toString().toLowerCase();
      final parentObj = _resolveParent(g as Map<String, dynamic>);
      final parentName = (parentObj?['name'] ?? '').toString().toLowerCase();
      return name.contains(q) || desc.contains(q) || parentName.contains(q);
    }).toList();
  }

  void _toggleExpandGroup(int groupId) {
    setState(() {
      if (_expandedGroupIds.contains(groupId)) {
        _expandedGroupIds.remove(groupId);
      } else {
        _expandedGroupIds.add(groupId);
      }
    });
  }

  void _toggleExpandChild(int childId) {
    setState(() {
      if (_expandedChildIds.contains(childId)) {
        _expandedChildIds.remove(childId);
      } else {
        _expandedChildIds.add(childId);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final displayed = _displayedGroups;
    final totalCount = _scopeGroups.length;
    final rootCount = _rootGroups.length;
    final divisionCount = totalCount - rootCount > 0 ? totalCount - rootCount : 0;

    // Aggregate statistics across groups
    final uniqueGates = <dynamic>{};
    final uniqueUsers = <dynamic>{};
    for (final g in _scopeGroups) {
      final gates = (g['gates'] as List?) ?? [];
      for (final item in gates) {
        final gid = item['gate']?['id'] ?? item['gateId'] ?? item['id'];
        if (gid != null) uniqueGates.add(gid);
      }
      final users = (g['users'] as List?) ?? [];
      for (final item in users) {
        final uid = item['user']?['id'] ?? item['userId'] ?? item['id'];
        if (uid != null) uniqueUsers.add(uid);
      }
    }

    return Scaffold(
      floatingActionButton: _canManage
          ? FloatingActionButton.extended(
              onPressed: () => _navigateToCreate(),
              backgroundColor: AppColors.primary,
              foregroundColor: Colors.white,
              icon: const Icon(Icons.add),
              label: const Text('New Railway Zone', style: TextStyle(fontWeight: FontWeight.bold)),
            )
          : null,
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () => _fetchScopeGroups(isManual: true),
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  // Role / Mode Banner
                  if (_hasAssignedScopes)
                    Container(
                      margin: const EdgeInsets.only(bottom: 14),
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEFF6FF),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0xFFBFDBFE)),
                      ),
                      child: const Row(
                        children: [
                          Icon(Icons.lock_outline, color: Color(0xFF1D4ED8), size: 18),
                          SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              'Assigned Scope View: Access restricted to your assigned operational Railway Zone and Divisions.',
                              style: TextStyle(color: Color(0xFF1E40AF), fontSize: 12.5, fontWeight: FontWeight.w500),
                            ),
                          ),
                        ],
                      ),
                    ),

                  // Top Stats Summary Card (Mirroring Web Overview)
                  Card(
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                      side: BorderSide(color: Colors.grey.shade200),
                    ),
                    elevation: 1,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceAround,
                        children: [
                          _buildStatItem('$totalCount', 'Total Groups'),
                          _buildStatItem('$rootCount', 'Railway Zones'),
                          _buildStatItem('$divisionCount', 'Divisions'),
                          _buildStatItem('${uniqueGates.length}', 'Scoped Gates'),
                          if (_canManage)
                            _buildStatItem('${uniqueUsers.length}', 'Team Members'),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),

                  // Search Bar + Refresh
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          decoration: InputDecoration(
                            hintText: 'Search railway zones or divisions...',
                            prefixIcon: const Icon(Icons.search, size: 20),
                            suffixIcon: _searchQuery.isNotEmpty
                                ? IconButton(
                                    icon: const Icon(Icons.clear, size: 18),
                                    onPressed: () => setState(() => _searchQuery = ''),
                                  )
                                : null,
                            contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(10),
                              borderSide: BorderSide(color: Colors.grey.shade300),
                            ),
                            filled: true,
                            fillColor: Colors.white,
                          ),
                          onChanged: (val) => setState(() => _searchQuery = val),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        icon: const Icon(Icons.refresh, color: AppColors.primary),
                        tooltip: 'Refresh',
                        onPressed: () => _fetchScopeGroups(isManual: true),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),

                  if (displayed.isEmpty)
                    Container(
                      padding: const EdgeInsets.all(40),
                      alignment: Alignment.center,
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.layers_outlined, size: 54, color: Colors.grey.shade400),
                          const SizedBox(height: 14),
                          Text(
                            _searchQuery.isNotEmpty ? 'No Matching Scope Groups' : 'No Railway Zones Created Yet',
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFF1E293B)),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            _canManage
                                ? 'Tap the "+ New Railway Zone" button below to create your first Zone (e.g. Central Railway, Western Railway).'
                                : 'No scope groups are currently assigned to your account.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
                          ),
                        ],
                      ),
                    )
                  else
                    ...displayed.map((group) => _buildGroupFolderCard(group as Map<String, dynamic>)),
                ],
              ),
            ),
    );
  }

  Widget _buildStatItem(String value, String label) {
    return Column(
      children: [
        Text(
          value,
          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: AppColors.primary),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: TextStyle(fontSize: 11, color: Colors.grey.shade600, fontWeight: FontWeight.w500),
        ),
      ],
    );
  }

  // --- Folder-Type UI Group Card (Web-Inspired) ---

  Widget _buildGroupFolderCard(Map<String, dynamic> group) {
    final groupId = group['id'] as int;
    final childDivisions = _getDirectChildren(groupId);
    final directGates = (group['gates'] as List?) ?? [];
    final recursiveGates = _getRecursiveGates(groupId);
    final directUsers = (group['users'] as List?) ?? [];
    final color = parseHexColor(group['color']);
    final isExpanded = _expandedGroupIds.contains(groupId);
    final previewGates = directGates.take(4).toList();
    final parentObj = _resolveParent(group);
    final isDivision = _isDivisionOrSubGroup(group);

    return Card(
      margin: const EdgeInsets.only(bottom: 14),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Colors.grey.shade200),
      ),
      elevation: 1,
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Top accent color stripe
          Container(height: 4, color: color),

          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Top Row: Hierarchy Type Badge + Actions Menu
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    if (parentObj != null)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF1F5F9),
                          borderRadius: BorderRadius.circular(5),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.folder, size: 12, color: Color(0xFF64748B)),
                            const SizedBox(width: 4),
                            Text(
                              '${parentObj['name']} /',
                              style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF64748B),
                              ),
                            ),
                          ],
                        ),
                      )
                    else
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: const Color(0xFFE0F2FE),
                          borderRadius: BorderRadius.circular(5),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.train, size: 12, color: Color(0xFF0369A1)),
                            const SizedBox(width: 4),
                            Text(
                              isDivision ? 'Railway Division' : 'Railway Zone (Main Scope)',
                              style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF0369A1),
                              ),
                            ),
                          ],
                        ),
                      ),
                    const Spacer(),
                    if (_canManage)
                      PopupMenuButton<String>(
                        icon: const Icon(Icons.more_vert, size: 20, color: Colors.grey),
                        onSelected: (val) {
                          if (val == 'add_division') {
                            _navigateToCreate(preselectedParentId: groupId);
                          } else if (val == 'edit') {
                            _navigateToEdit(group);
                          } else if (val == 'delete') {
                            _confirmDeleteGroup(group);
                          }
                        },
                        itemBuilder: (_) => [
                          const PopupMenuItem(
                            value: 'add_division',
                            child: Row(
                              children: [
                                Icon(Icons.create_new_folder_outlined, size: 18, color: Color(0xFF7C3AED)),
                                SizedBox(width: 8),
                                Text('Add Division'),
                              ],
                            ),
                          ),
                          const PopupMenuItem(
                            value: 'edit',
                            child: Row(
                              children: [
                                Icon(Icons.edit, size: 18, color: AppColors.primary),
                                SizedBox(width: 8),
                                Text('Edit Scope Group'),
                              ],
                            ),
                          ),
                          const PopupMenuItem(
                            value: 'delete',
                            child: Row(
                              children: [
                                Icon(Icons.delete_outline, size: 18, color: AppColors.danger),
                                SizedBox(width: 8),
                                Text('Delete Scope Group', style: TextStyle(color: AppColors.danger)),
                              ],
                            ),
                          ),
                        ],
                      ),
                  ],
                ),
                const SizedBox(height: 8),

                // Group Name
                InkWell(
                  onTap: () => _navigateToGroupDetail(group),
                  child: Row(
                    children: [
                      Container(
                        width: 12,
                        height: 12,
                        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          group['name'] ?? 'Scope Group',
                          style: const TextStyle(
                            fontWeight: FontWeight.bold,
                            fontSize: 16.5,
                            color: Color(0xFF0F172A),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),

                // Description
                if (group['description'] != null && group['description'].toString().isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(
                    group['description'],
                    style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                const SizedBox(height: 12),

                // Metadata Badges Row
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    // Direct Gates Pill
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFFE0F2FE),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.device_hub, size: 13, color: Color(0xFF0369A1)),
                          const SizedBox(width: 5),
                          Text(
                            '${directGates.length} ${directGates.length == 1 ? "Gate" : "Gates"}',
                            style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: Color(0xFF0369A1)),
                          ),
                        ],
                      ),
                    ),

                    // Expandable Sub-Divisions Button
                    if (childDivisions.isNotEmpty)
                      InkWell(
                        onTap: () => _toggleExpandGroup(groupId),
                        borderRadius: BorderRadius.circular(6),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                          decoration: BoxDecoration(
                            color: const Color(0xFFEDE9FE),
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(color: const Color(0xFFDDD6FE)),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(Icons.folder_copy, size: 13, color: Color(0xFF6D28D9)),
                              const SizedBox(width: 5),
                              Text(
                                '${childDivisions.length} ${childDivisions.length == 1 ? "Division" : "Divisions"} ${isExpanded ? "▲" : "▼"}',
                                style: const TextStyle(
                                  fontSize: 11.5,
                                  fontWeight: FontWeight.w700,
                                  color: Color(0xFF6D28D9),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),

                    // Team Members Pill (if manager)
                    if (_canManage)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                        decoration: BoxDecoration(
                          color: const Color(0xFFECFDF5),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.people_outline, size: 13, color: Color(0xFF065F46)),
                            const SizedBox(width: 5),
                            Text(
                              '${directUsers.length} ${directUsers.length == 1 ? "User" : "Users"}',
                              style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: Color(0xFF065F46)),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),

                // Direct Gates Chips Preview
                const SizedBox(height: 12),
                if (previewGates.isNotEmpty)
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      ...previewGates.map((item) {
                        final g = item['gate'] ?? item;
                        return Container(
                          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                            color: const Color(0xFFF1F5F9),
                            borderRadius: BorderRadius.circular(4),
                            border: Border.all(color: const Color(0xFFE2E8F0)),
                          ),
                          child: Text(
                            g['lcNumber'] ?? 'Gate',
                            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Color(0xFF334155)),
                          ),
                        );
                      }),
                      if (directGates.length > previewGates.length)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                            color: Colors.grey.shade100,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            '+${directGates.length - previewGates.length} more',
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Colors.grey.shade600),
                          ),
                        ),
                    ],
                  )
                else if (childDivisions.isNotEmpty)
                  Text(
                    'LC Gates are assigned via nested divisions (${recursiveGates.length} total hierarchy gates).',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade500, fontStyle: FontStyle.italic),
                  ),

                // EXPANDABLE SUB-DIVISIONS DRAWER (Mirroring Web Folder UI)
                if (isExpanded && childDivisions.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF8FAFC),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: const Color(0xFFE2E8F0)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // Drawer Header
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Row(
                              children: [
                                const Icon(Icons.folder_open, size: 16, color: Color(0xFF6D28D9)),
                                const SizedBox(width: 6),
                                Text(
                                  'Divisions in ${group["name"]} (${childDivisions.length})',
                                  style: const TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 12.5,
                                    color: Color(0xFF1E293B),
                                  ),
                                ),
                              ],
                            ),
                            if (_canManage)
                              InkWell(
                                onTap: () => _navigateToCreate(preselectedParentId: groupId),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFFEDE9FE),
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: const Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(Icons.add, size: 13, color: Color(0xFF6D28D9)),
                                      SizedBox(width: 3),
                                      Text(
                                        'Add Division',
                                        style: TextStyle(
                                          fontSize: 11,
                                          fontWeight: FontWeight.bold,
                                          color: Color(0xFF6D28D9),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: 10),

                        // Child Divisions List
                        ...childDivisions.map((child) {
                          final childId = child['id'] as int;
                          final grandChildren = _getDirectChildren(childId);
                          final childGates = (child['gates'] as List?) ?? [];
                          final childColor = parseHexColor(child['color']);
                          final isChildExpanded = _expandedChildIds.contains(childId);

                          return Container(
                            margin: const EdgeInsets.only(bottom: 8),
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: const Color(0xFFE2E8F0)),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Container(
                                      width: 28,
                                      height: 28,
                                      decoration: BoxDecoration(
                                        color: childColor.withValues(alpha: 0.12),
                                        borderRadius: BorderRadius.circular(6),
                                      ),
                                      child: Icon(Icons.folder, color: childColor, size: 16),
                                    ),
                                    const SizedBox(width: 8),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            child['name'] ?? 'Division',
                                            style: const TextStyle(
                                              fontWeight: FontWeight.bold,
                                              fontSize: 13.5,
                                              color: Color(0xFF0F172A),
                                            ),
                                          ),
                                          if (child['description'] != null && child['description'].toString().isNotEmpty)
                                            Text(
                                              child['description'],
                                              style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600),
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                        ],
                                      ),
                                    ),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                      decoration: BoxDecoration(
                                        color: const Color(0xFFE0F2FE),
                                        borderRadius: BorderRadius.circular(4),
                                      ),
                                      child: Text(
                                        '${childGates.length} Gates',
                                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF0369A1)),
                                      ),
                                    ),
                                    if (grandChildren.isNotEmpty) ...[
                                      const SizedBox(width: 6),
                                      InkWell(
                                        onTap: () => _toggleExpandChild(childId),
                                        child: Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                          decoration: BoxDecoration(
                                            color: const Color(0xFFEDE9FE),
                                            borderRadius: BorderRadius.circular(4),
                                          ),
                                          child: Text(
                                            '${grandChildren.length} Sub ${isChildExpanded ? "▲" : "▼"}',
                                            style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Color(0xFF6D28D9)),
                                          ),
                                        ),
                                      ),
                                    ],
                                  ],
                                ),

                                // Grandchildren Drawer (Subgroup within subgroup / Sections)
                                if (isChildExpanded && grandChildren.isNotEmpty) ...[
                                  const SizedBox(height: 8),
                                  Container(
                                    padding: const EdgeInsets.all(8),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFF5F3FF),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          'Sub-Units / Sections in ${child["name"]}:',
                                          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF6D28D9)),
                                        ),
                                        const SizedBox(height: 4),
                                        ...grandChildren.map((gc) {
                                          final gcGates = (gc['gates'] as List?) ?? [];
                                          return Padding(
                                            padding: const EdgeInsets.symmetric(vertical: 3),
                                            child: InkWell(
                                              onTap: () => _navigateToGroupDetail(gc as Map<String, dynamic>),
                                              child: Row(
                                                children: [
                                                  const Icon(Icons.folder, size: 13, color: Color(0xFF8B5CF6)),
                                                  const SizedBox(width: 6),
                                                  Expanded(
                                                    child: Text(
                                                      gc['name'] ?? '',
                                                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF1E293B)),
                                                    ),
                                                  ),
                                                  Text(
                                                    '${gcGates.length} Gates',
                                                    style: TextStyle(fontSize: 10.5, color: Colors.grey.shade600),
                                                  ),
                                                  const Icon(Icons.chevron_right, size: 14, color: Colors.grey),
                                                ],
                                              ),
                                            ),
                                          );
                                        }),
                                      ],
                                    ),
                                  ),
                                ],

                                // Child Actions Footer
                                const SizedBox(height: 8),
                                Row(
                                  children: [
                                    InkWell(
                                      onTap: () => _navigateToGroupDetail(child as Map<String, dynamic>),
                                      child: const Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Text(
                                            'Open Division',
                                            style: TextStyle(
                                              fontSize: 12,
                                              fontWeight: FontWeight.bold,
                                              color: AppColors.primary,
                                            ),
                                          ),
                                          Icon(Icons.chevron_right, size: 14, color: AppColors.primary),
                                        ],
                                      ),
                                    ),
                                    const Spacer(),
                                    if (_canManage) ...[
                                      InkWell(
                                        onTap: () => _navigateToCreate(preselectedParentId: childId),
                                        child: Padding(
                                          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                                          child: Text(
                                            '+ Sub-Group',
                                            style: TextStyle(fontSize: 11.5, color: Colors.purple.shade700, fontWeight: FontWeight.bold),
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      InkWell(
                                        onTap: () => _navigateToEdit(child as Map<String, dynamic>),
                                        child: const Padding(
                                          padding: EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                                          child: Text(
                                            'Edit',
                                            style: TextStyle(fontSize: 11.5, color: AppColors.primary, fontWeight: FontWeight.bold),
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      InkWell(
                                        onTap: () => _confirmDeleteGroup(child as Map<String, dynamic>),
                                        child: const Padding(
                                          padding: EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                                          child: Text(
                                            'Delete',
                                            style: TextStyle(fontSize: 11.5, color: Colors.red, fontWeight: FontWeight.bold),
                                          ),
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                              ],
                            ),
                          );
                        }),
                      ],
                    ),
                  ),
                ],

                // Card Footer Actions
                const SizedBox(height: 14),
                const Divider(height: 1),
                const SizedBox(height: 10),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    InkWell(
                      onTap: () => _navigateToGroupDetail(group),
                      child: Row(
                        children: [
                          Text(
                            'Open Zone & Divisions (${childDivisions.length})',
                            style: const TextStyle(
                              fontSize: 12.5,
                              fontWeight: FontWeight.bold,
                              color: AppColors.primary,
                            ),
                          ),
                          const Icon(Icons.arrow_forward, size: 14, color: AppColors.primary),
                        ],
                      ),
                    ),
                    if (_canManage)
                      Row(
                        children: [
                          OutlinedButton.icon(
                            onPressed: () => _navigateToCreate(preselectedParentId: groupId),
                            icon: const Icon(Icons.add, size: 14),
                            label: const Text('Add Division', style: TextStyle(fontSize: 11.5)),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: const Color(0xFF6D28D9),
                              side: const BorderSide(color: Color(0xFFDDD6FE)),
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                          ),
                          const SizedBox(width: 6),
                          OutlinedButton.icon(
                            onPressed: () => _navigateToEdit(group),
                            icon: const Icon(Icons.edit, size: 14),
                            label: const Text('Edit', style: TextStyle(fontSize: 11.5)),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: AppColors.primary,
                              side: BorderSide(color: Colors.grey.shade300),
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                          ),
                        ],
                      ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// DEDICATED SCOPE GROUP DETAIL PAGE WITH BREADCRUMB & HIERARCHY NAVIGATION
class ScopeGroupDetailPage extends StatefulWidget {
  final Map<String, dynamic> group;
  final List<dynamic> allScopeGroups;
  final String token;
  final bool canManage;
  final VoidCallback? onRefreshRequested;

  const ScopeGroupDetailPage({
    super.key,
    required this.group,
    required this.allScopeGroups,
    required this.token,
    required this.canManage,
    this.onRefreshRequested,
  });

  @override
  State<ScopeGroupDetailPage> createState() => _ScopeGroupDetailPageState();
}

class _ScopeGroupDetailPageState extends State<ScopeGroupDetailPage> {
  late Map<String, dynamic> _group;
  late List<dynamic> _allScopeGroups;
  String _searchQuery = '';
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _group = widget.group;
    _allScopeGroups = widget.allScopeGroups;
    _refreshCurrentGroupData();
  }

  Future<void> _refreshCurrentGroupData() async {
    final groupId = _group['id'];
    if (groupId == null) return;
    setState(() => _isLoading = true);
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/scope-groups/$groupId'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted && data is Map<String, dynamic>) {
          setState(() {
            _group = data;
            _isLoading = false;
          });
        }
      } else {
        if (mounted) setState(() => _isLoading = false);
      }
    } catch (_) {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Map<String, dynamic>? _resolveParent(Map<String, dynamic> group) {
    if (group['parent'] is Map) {
      return group['parent'] as Map<String, dynamic>;
    }
    final pid = group['parentId'];
    if (pid != null) {
      final found = _allScopeGroups.firstWhere((g) => g['id'] == pid, orElse: () => null);
      if (found != null) return found as Map<String, dynamic>;
    }

    final gName = (group['name'] ?? '').toString().toLowerCase();
    for (final zoneGroup in _allScopeGroups) {
      if (zoneGroup['id'] == group['id']) continue;
      final zoneName = (zoneGroup['name'] ?? '').toString().toLowerCase();
      final isZone = zoneName.contains('railway') || RailwayData.zones.any((z) => zoneName.contains(z.toLowerCase()));
      if (isZone) {
        final zoneDivisions = RailwayData.divisionsForZone(zoneGroup['name']);
        if (zoneDivisions.any((d) => gName.contains(d.toLowerCase())) || gName.contains('division')) {
          return zoneGroup as Map<String, dynamic>;
        }
      }
    }
    return null;
  }

  List<dynamic> _getDirectChildren(int parentId) {
    final parent = _allScopeGroups.firstWhere((g) => g['id'] == parentId, orElse: () => null);
    if (parent == null) return [];
    final parentName = (parent['name'] ?? '').toString().toLowerCase();
    final isZone = parentName.contains('railway') || RailwayData.zones.any((z) => parentName.contains(z.toLowerCase()));
    final zoneDivisions = isZone ? RailwayData.divisionsForZone(parent['name']) : <String>[];

    return _allScopeGroups.where((g) {
      if (g['id'] == parentId) return false;
      if (g['parentId'] == parentId) return true;
      if (g['parentId'] == null && isZone) {
        final gName = (g['name'] ?? '').toString().toLowerCase();
        if (zoneDivisions.any((d) => gName.contains(d.toLowerCase()))) {
          return true;
        }
        if (gName.contains('division')) {
          final otherZones = _allScopeGroups.where((z) =>
              z['id'] != parentId && (z['name'] ?? '').toString().toLowerCase().contains('railway'));
          if (otherZones.isEmpty) return true;
        }
      }
      return false;
    }).toList();
  }

  List<dynamic> _getRecursiveGates(int groupId) {
    final descendantIds = <int>{groupId};
    final queue = [groupId];
    while (queue.isNotEmpty) {
      final curr = queue.removeAt(0);
      final children = _getDirectChildren(curr);
      for (final c in children) {
        final cid = c['id'] as int?;
        if (cid != null && !descendantIds.contains(cid)) {
          descendantIds.add(cid);
          queue.add(cid);
        }
      }
    }

    final gateMap = <dynamic, dynamic>{};
    for (final g in _allScopeGroups) {
      if (descendantIds.contains(g['id'])) {
        final gates = (g['gates'] as List?) ?? [];
        for (final item in gates) {
          final gate = item['gate'] ?? item;
          final gid = gate['id'];
          if (gid != null && !gateMap.containsKey(gid)) {
            gateMap[gid] = gate;
          }
        }
      }
    }
    return gateMap.values.toList();
  }

  List<Map<String, dynamic>> _getBreadcrumbs() {
    final crumbs = <Map<String, dynamic>>[];
    Map<String, dynamic>? curr = _group;
    final visited = <int>{};
    while (curr != null && curr['id'] != null && !visited.contains(curr['id'])) {
      visited.add(curr['id'] as int);
      crumbs.insert(0, curr);
      final parentObj = _resolveParent(curr);
      if (parentObj != null && parentObj['id'] != curr['id']) {
        curr = parentObj;
      } else {
        curr = null;
      }
    }
    return crumbs;
  }

  void _navigateToCreateChild() async {
    final result = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CreateEditScopeGroupScreen(
          token: widget.token,
          preselectedParentId: _group['id'] as int?,
          existingScopeGroups: _allScopeGroups,
        ),
      ),
    );
    if (result == true) {
      widget.onRefreshRequested?.call();
      _refreshCurrentGroupData();
    }
  }

  void _navigateToEdit() async {
    final result = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CreateEditScopeGroupScreen(
          group: _group,
          token: widget.token,
          existingScopeGroups: _allScopeGroups,
        ),
      ),
    );
    if (result == true) {
      widget.onRefreshRequested?.call();
      _refreshCurrentGroupData();
    }
  }

  void _navigateToGateDetails(Map<String, dynamic> gate) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => GateDevicesDetailPage(
          gate: gate,
          token: widget.token,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final gates = (_group['gates'] as List?) ?? [];
    final color = parseHexColor(_group['color']);
    final groupId = _group['id'] as int? ?? 0;
    final directChildren = _getDirectChildren(groupId);
    final recursiveGates = _getRecursiveGates(groupId);
    final breadcrumbs = _getBreadcrumbs();
    final parentObj = _resolveParent(_group);

    final filteredGates = gates.where((item) {
      if (_searchQuery.isEmpty) return true;
      final g = (item['gate'] as Map?) ?? {};
      final q = _searchQuery.toLowerCase();
      final lc = (g['lcNumber'] ?? '').toString().toLowerCase();
      final loc = (g['locationName'] ?? '').toString().toLowerCase();
      final name = (g['name'] ?? '').toString().toLowerCase();
      return lc.contains(q) || loc.contains(q) || name.contains(q);
    }).toList();

    // Aggregate Masters & Slaves across gates
    int totalMasters = 0;
    int totalSlaves = 0;
    for (final item in gates) {
      final g = (item['gate'] as Map?) ?? {};
      final masters = (g['masters'] as List?) ?? [];
      totalMasters += masters.length;
      for (final m in masters) {
        final slaves = (m['childDevices'] as List?) ?? [];
        totalSlaves += slaves.length;
      }
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(_group['name'] ?? 'Scope Group', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF0F172A),
        elevation: 1,
        actions: [
          if (widget.canManage)
            IconButton(
              icon: const Icon(Icons.edit, size: 20),
              tooltip: 'Edit Scope Group',
              onPressed: _navigateToEdit,
            ),
          IconButton(
            icon: const Icon(Icons.refresh, size: 20),
            tooltip: 'Refresh',
            onPressed: _refreshCurrentGroupData,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                // Breadcrumbs Navigation Bar (Mirroring Web)
                Container(
                  margin: const EdgeInsets.only(bottom: 14),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF1F5F9),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: [
                        InkWell(
                          onTap: () => Navigator.pop(context),
                          child: const Row(
                            children: [
                              Icon(Icons.home, size: 14, color: AppColors.primary),
                              SizedBox(width: 4),
                              Text('Scope Groups', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary)),
                            ],
                          ),
                        ),
                        ...breadcrumbs.asMap().entries.map((entry) {
                          final idx = entry.key;
                          final crumb = entry.value;
                          final isLast = idx == breadcrumbs.length - 1;

                          return Row(
                            children: [
                              const Padding(
                                padding: EdgeInsets.symmetric(horizontal: 6),
                                child: Text('/', style: TextStyle(fontSize: 12, color: Color(0xFF94A3B8))),
                              ),
                              if (isLast)
                                Text(
                                  crumb['name'] ?? '',
                                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                )
                              else
                                InkWell(
                                  onTap: () {
                                    setState(() => _group = crumb);
                                    _refreshCurrentGroupData();
                                  },
                                  child: Text(
                                    crumb['name'] ?? '',
                                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.primary),
                                  ),
                                ),
                            ],
                          );
                        }),
                      ],
                    ),
                  ),
                ),

                // Group Hero Card
                Card(
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                    side: BorderSide(color: Colors.grey.shade200),
                  ),
                  elevation: 1,
                  child: Padding(
                    padding: const EdgeInsets.all(18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (parentObj != null)
                          Container(
                            margin: const EdgeInsets.only(bottom: 8),
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF1F5F9),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(Icons.folder, size: 12, color: Color(0xFF64748B)),
                                const SizedBox(width: 4),
                                Text(
                                  '${parentObj['name']} /',
                                  style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B)),
                                ),
                              ],
                            ),
                          ),
                        Row(
                          children: [
                            Container(
                              width: 14,
                              height: 14,
                              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                _group['name'] ?? 'Scope Group',
                                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                              ),
                            ),
                          ],
                        ),
                        if (_group['description'] != null && _group['description'].toString().isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text(
                            _group['description'],
                            style: TextStyle(fontSize: 13.5, color: Colors.grey.shade700, height: 1.4),
                          ),
                        ],
                        const SizedBox(height: 16),
                        const Divider(),
                        const SizedBox(height: 10),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceAround,
                          children: [
                            _buildSummaryStat('${gates.length}', 'Direct Gates'),
                            _buildSummaryStat('${recursiveGates.length}', 'Total Hierarchy'),
                            _buildSummaryStat('$totalMasters', 'Masters'),
                            _buildSummaryStat('$totalSlaves', 'Slaves'),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 20),

                // Sub-Divisions & Child Folders Section (Mirroring Web)
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.folder_copy, color: Color(0xFF6D28D9), size: 18),
                        const SizedBox(width: 6),
                        Text(
                          'Divisions / Sub-Groups (${directChildren.length})',
                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF1E293B)),
                        ),
                      ],
                    ),
                    if (widget.canManage)
                      ElevatedButton.icon(
                        onPressed: _navigateToCreateChild,
                        icon: const Icon(Icons.add, size: 15),
                        label: const Text('Add Division', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppColors.primary,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  'Divisions and sub-groups nested inside ${_group["name"]}. Users assigned to this Zone automatically inherit access to all child divisions.',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                ),
                const SizedBox(height: 10),

                if (directChildren.isEmpty)
                  Container(
                    padding: const EdgeInsets.all(22),
                    margin: const EdgeInsets.only(bottom: 20),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF8FAFC),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: const Color(0xFFE2E8F0)),
                    ),
                    alignment: Alignment.center,
                    child: Column(
                      children: [
                        Icon(Icons.folder_outlined, color: Colors.grey.shade400, size: 30),
                        const SizedBox(height: 6),
                        Text(
                          'No nested divisions or sub-groups in this scope group yet.',
                          style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
                        ),
                        if (widget.canManage) ...[
                          const SizedBox(height: 8),
                          OutlinedButton.icon(
                            onPressed: _navigateToCreateChild,
                            icon: const Icon(Icons.add, size: 14),
                            label: const Text('Create First Division', style: TextStyle(fontSize: 12)),
                          ),
                        ],
                      ],
                    ),
                  )
                else
                  ...directChildren.map((child) {
                    final childGates = (child['gates'] as List?) ?? [];
                    final grandChildren = _getDirectChildren(child['id'] as int);
                    final childColor = parseHexColor(child['color']);

                    return Card(
                      margin: const EdgeInsets.only(bottom: 10),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                        side: BorderSide(color: Colors.grey.shade200),
                      ),
                      elevation: 0.5,
                      child: InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: () {
                          Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (_) => ScopeGroupDetailPage(
                                group: child as Map<String, dynamic>,
                                allScopeGroups: _allScopeGroups,
                                token: widget.token,
                                canManage: widget.canManage,
                                onRefreshRequested: widget.onRefreshRequested,
                              ),
                            ),
                          ).then((_) => _refreshCurrentGroupData());
                        },
                        child: Padding(
                          padding: const EdgeInsets.all(14),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Container(
                                    width: 32,
                                    height: 32,
                                    decoration: BoxDecoration(
                                      color: childColor.withValues(alpha: 0.12),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: Icon(Icons.folder, color: childColor, size: 18),
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          child['name'] ?? '',
                                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
                                        ),
                                        if (child['description'] != null && child['description'].toString().isNotEmpty)
                                          Text(
                                            child['description'],
                                            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                      ],
                                    ),
                                  ),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFE0F2FE),
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                    child: Text(
                                      '${childGates.length} Gates',
                                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF0369A1)),
                                    ),
                                  ),
                                ],
                              ),
                              if (grandChildren.isNotEmpty) ...[
                                const SizedBox(height: 6),
                                Row(
                                  children: [
                                    const Icon(Icons.folder_copy, size: 12, color: Color(0xFF6D28D9)),
                                    const SizedBox(width: 4),
                                    Text(
                                      '${grandChildren.length} Sub-Units / Sections',
                                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Color(0xFF6D28D9)),
                                    ),
                                  ],
                                ),
                              ],
                              const SizedBox(height: 8),
                              const Row(
                                mainAxisAlignment: MainAxisAlignment.end,
                                children: [
                                  Text(
                                    'Open Division',
                                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary),
                                  ),
                                  SizedBox(width: 2),
                                  Icon(Icons.chevron_right, size: 16, color: AppColors.primary),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    );
                  }),
                const SizedBox(height: 18),

                // Search Bar for Gates
                TextField(
                  decoration: InputDecoration(
                    hintText: 'Search gates in this scope...',
                    prefixIcon: const Icon(Icons.search, size: 20),
                    suffixIcon: _searchQuery.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.clear, size: 18),
                            onPressed: () => setState(() => _searchQuery = ''),
                          )
                        : null,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: Colors.grey.shade300)),
                    filled: true,
                    fillColor: Colors.white,
                  ),
                  onChanged: (val) => setState(() => _searchQuery = val),
                ),
                const SizedBox(height: 16),

                // Gates Section Title
                Text(
                  'Included LC Gates (${filteredGates.length})',
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFF1E293B)),
                ),
                const SizedBox(height: 10),

                if (filteredGates.isEmpty)
                  Container(
                    padding: const EdgeInsets.all(32),
                    alignment: Alignment.center,
                    child: Text(
                      _searchQuery.isNotEmpty ? 'No gates match your search.' : 'No gates directly assigned to this scope group.',
                      style: TextStyle(color: Colors.grey.shade500, fontSize: 13.5),
                    ),
                  )
                else
                  ...filteredGates.map((item) {
                    final g = (item['gate'] as Map?) ?? {};
                    final masters = (g['masters'] as List?) ?? [];
                    int slavesCount = 0;
                    for (final m in masters) {
                      final sList = (m['childDevices'] as List?) ?? [];
                      slavesCount += sList.length;
                    }

                    return Card(
                      margin: const EdgeInsets.only(bottom: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                        side: BorderSide(color: Colors.grey.shade200),
                      ),
                      elevation: 1,
                      child: InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: () => _navigateToGateDetails(g.cast<String, dynamic>()),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFE0F2FE),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: Text(
                                      g['lcNumber'] ?? 'LC-Gate',
                                      style: const TextStyle(
                                        fontWeight: FontWeight.bold,
                                        fontSize: 13,
                                        color: Color(0xFF0369A1),
                                      ),
                                    ),
                                  ),
                                  const Row(
                                    children: [
                                      Text(
                                        'Inspect Devices',
                                        style: TextStyle(fontSize: 12, color: AppColors.primary, fontWeight: FontWeight.w600),
                                      ),
                                      SizedBox(width: 4),
                                      Icon(Icons.chevron_right, size: 16, color: AppColors.primary),
                                    ],
                                  ),
                                ],
                              ),
                              const SizedBox(height: 8),
                              Text(
                                g['locationName'] ?? g['name'] ?? 'LC Gate',
                                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A)),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                '${g['zone'] ?? ''} • ${g['division'] ?? ''}',
                                style: TextStyle(fontSize: 12.5, color: Colors.grey.shade600),
                              ),
                              const SizedBox(height: 12),
                              Row(
                                children: [
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFFEF3C7),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: Text(
                                      '${masters.length} Masters',
                                      style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Color(0xFF92400E)),
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFECFDF5),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: Text(
                                      '$slavesCount Slaves',
                                      style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Color(0xFF065F46)),
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    );
                  }),
              ],
            ),
    );
  }

  Widget _buildSummaryStat(String value, String label) {
    return Column(
      children: [
        Text(
          value,
          style: const TextStyle(fontSize: 19, fontWeight: FontWeight.bold, color: AppColors.primary),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: TextStyle(fontSize: 11, color: Colors.grey.shade600, fontWeight: FontWeight.w500),
        ),
      ],
    );
  }
}

/// DEDICATED GATE DEVICES & TELEMETRY PAGE
class GateDevicesDetailPage extends StatefulWidget {
  final Map<String, dynamic> gate;
  final String token;

  const GateDevicesDetailPage({
    super.key,
    required this.gate,
    required this.token,
  });

  @override
  State<GateDevicesDetailPage> createState() => _GateDevicesDetailPageState();
}

class _GateDevicesDetailPageState extends State<GateDevicesDetailPage> {
  late Map<String, dynamic> _gate;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _gate = widget.gate;
    _fetchLatestGateData();
  }

  Future<void> _fetchLatestGateData({bool isManual = false}) async {
    final gateId = _gate['id'];
    if (gateId == null) return;
    if (!isManual) setState(() => _isLoading = true);
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/$gateId'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted && data is Map<String, dynamic>) {
          setState(() {
            _gate = data;
            _isLoading = false;
          });
          if (isManual) {
            AppFeedback.showSuccess(context, 'Gate telemetry updated.');
          }
        }
      } else {
        if (mounted) setState(() => _isLoading = false);
      }
    } catch (_) {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final masters = (_gate['masters'] as List?) ?? [];
    int totalSlaves = 0;
    for (final m in masters) {
      final slaves = (m['childDevices'] as List?) ?? [];
      totalSlaves += slaves.length;
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(_gate['lcNumber'] ?? 'Gate Details'),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF0F172A),
        elevation: 1,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh Telemetry',
            onPressed: () => _fetchLatestGateData(isManual: true),
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                // Gate Header Card
                Card(
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                    side: BorderSide(color: Colors.grey.shade200),
                  ),
                  elevation: 1,
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(
                                color: const Color(0xFFE0F2FE),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                _gate['lcNumber'] ?? 'LC-Gate',
                                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0369A1)),
                              ),
                            ),
                            const Spacer(),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(
                                color: const Color(0xFFFEF3C7),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                '${masters.length} Masters',
                                style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Color(0xFF92400E)),
                              ),
                            ),
                            const SizedBox(width: 6),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(
                                color: const Color(0xFFECFDF5),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                '$totalSlaves Slaves',
                                style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Color(0xFF065F46)),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 10),
                        Text(
                          _gate['locationName'] ?? _gate['name'] ?? 'LC Gate',
                          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Railway Section: ${_gate['zone'] ?? "N/A"} • ${_gate['division'] ?? "N/A"}',
                          style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
                        ),
                        if (_gate['latitude'] != null && _gate['longitude'] != null) ...[
                          const SizedBox(height: 4),
                          Text(
                            'Coordinates: ${_gate['latitude']}, ${_gate['longitude']}',
                            style: TextStyle(fontSize: 12, color: Colors.grey.shade500),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 20),

                // Hardware Telemetry & Connected Devices Title
                const Text(
                  'Hardware Telemetry & Connected Devices',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFF0F172A)),
                ),
                const SizedBox(height: 4),
                Text(
                  'Live configuration of Master units and Slave sensors installed at this gate.',
                  style: TextStyle(fontSize: 12.5, color: Colors.grey.shade600),
                ),
                const SizedBox(height: 14),

                if (masters.isEmpty)
                  Container(
                    padding: const EdgeInsets.all(32),
                    alignment: Alignment.center,
                    child: Column(
                      children: [
                        Icon(Icons.developer_board_off_outlined, size: 40, color: Colors.grey.shade400),
                        const SizedBox(height: 10),
                        const Text(
                          'No Master Units Configured',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF1E293B)),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'This LC gate currently does not have any master telemetry units installed.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Colors.grey.shade600, fontSize: 12.5),
                        ),
                      ],
                    ),
                  )
                else
                  ...masters.map((master) {
                    final slaves = (master['childDevices'] as List?) ?? [];
                    final isSolar = (master['powerSource'] ?? '').toString().toUpperCase() == 'SOLAR';

                    return Card(
                      margin: const EdgeInsets.only(bottom: 16),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                        side: BorderSide(color: Colors.grey.shade200),
                      ),
                      elevation: 1,
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            // Master Header
                            Row(
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(8),
                                  decoration: BoxDecoration(
                                    color: AppColors.primary.withValues(alpha: 0.1),
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: const Icon(Icons.developer_board, color: AppColors.primary, size: 22),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        master['serialNumber'] ?? 'Master Unit',
                                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A)),
                                      ),
                                      Text(
                                        'Master Sequence #${master['masterSequence'] ?? 1}',
                                        style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                                      ),
                                    ],
                                  ),
                                ),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                  decoration: BoxDecoration(
                                    color: isSolar ? const Color(0xFFFEF3C7) : const Color(0xFFE0F2FE),
                                    borderRadius: BorderRadius.circular(6),
                                  ),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(
                                        isSolar ? Icons.wb_sunny : Icons.bolt,
                                        size: 13,
                                        color: isSolar ? const Color(0xFFB45309) : const Color(0xFF0369A1),
                                      ),
                                      const SizedBox(width: 4),
                                      Text(
                                        isSolar ? 'Solar' : 'Direct DC',
                                        style: TextStyle(
                                          fontSize: 11,
                                          fontWeight: FontWeight.bold,
                                          color: isSolar ? const Color(0xFFB45309) : const Color(0xFF0369A1),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 14),

                            // Slave Devices Header
                            Row(
                              children: [
                                const Icon(Icons.sensors, size: 15, color: Color(0xFF0369A1)),
                                const SizedBox(width: 6),
                                Text(
                                  'Connected Slave Devices (${slaves.length})',
                                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF1E293B)),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),

                            if (slaves.isEmpty)
                              Container(
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(
                                  color: Colors.grey.shade50,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Text(
                                  'No slave devices connected to this master unit yet.',
                                  style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
                                ),
                              )
                            else
                              ...slaves.map((dev) {
                                final isHall = dev['type'] == 'DEVICE_1';
                                return Container(
                                  margin: const EdgeInsets.only(bottom: 6),
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFFF8FAFC),
                                    borderRadius: BorderRadius.circular(6),
                                    border: Border.all(color: const Color(0xFFE2E8F0)),
                                  ),
                                  child: Row(
                                    children: [
                                      const Icon(Icons.cable, size: 16, color: Color(0xFF64748B)),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              dev['serialNumber'] ?? 'Slave',
                                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5, color: Color(0xFF0F172A)),
                                            ),
                                            Text(
                                              isHall ? 'Hall Effect + Limit Switch (Type A)' : 'Tilt Sensor (Type B)',
                                              style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                                            ),
                                          ],
                                        ),
                                      ),
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                        decoration: BoxDecoration(
                                          color: Colors.white,
                                          borderRadius: BorderRadius.circular(4),
                                          border: Border.all(color: Colors.grey.shade300),
                                        ),
                                        child: Text(
                                          'Seq #${dev['deviceSequence'] ?? 1}',
                                          style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Color(0xFF475569)),
                                        ),
                                      ),
                                    ],
                                  ),
                                );
                              }),
                          ],
                        ),
                      ),
                    );
                  }),
              ],
            ),
    );
  }
}
