import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import '../../components/device_info_sheet.dart';

Color parseHexColor(String? hexString) {
  if (hexString == null || hexString.isEmpty) return const Color(0xFF0B3C7A);
  try {
    final hex = hexString.replaceAll('#', '');
    return Color(int.parse('FF$hex', radix: 16));
  } catch (_) {
    return const Color(0xFF0B3C7A);
  }
}

String getFullImageUrl(String? url) {
  if (url == null || url.isEmpty) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try {
    final uri = Uri.parse(baseUrl);
    final origin = '${uri.scheme}://${uri.host}${uri.hasPort ? ':${uri.port}' : ''}';
    return '$origin$url';
  } catch (_) {
    return url;
  }
}

class LCGatesScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  const LCGatesScreen({super.key, required this.user});

  @override
  State<LCGatesScreen> createState() => _LCGatesScreenState();
}

class _LCGatesScreenState extends State<LCGatesScreen> {
  bool _isLoading = true;
  String _token = '';
  bool _isDeveloper = false;

  // Breadcrumbs: List of {id: int?, name: String, color: String?}
  final List<Map<String, dynamic>> _breadcrumbs = [
    {'id': null, 'name': 'Root Directory', 'color': null}
  ];

  int? get _currentFolderId => _breadcrumbs.last['id'] as int?;

  // View Mode: 'folder' | 'flat' | 'detail'
  String _viewMode = 'folder';

  // Selected Cluster for Full Drilldown
  Map<String, dynamic>? _selectedGate;

  // Drilldown Active Tab: 'about' | 'telemetry'
  String _clusterTab = 'about';

  // Search Filter
  final _searchCtrl = TextEditingController();
  String _searchQuery = '';

  // Data
  List<dynamic> _scopeGroups = [];
  List<dynamic> _gates = [];

  @override
  void initState() {
    super.initState();
    _isDeveloper = widget.user['role'] == 'Developer';
    _loadTokenAndFetch();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadTokenAndFetch() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token') ?? '';
    if (!mounted) return;
    setState(() => _token = token);
    await _fetchData();
  }

  Future<void> _fetchData({bool isManual = false}) async {
    if (!isManual) setState(() => _isLoading = true);
    try {
      final headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $_token',
      };

      // 1. Fetch user scope hierarchy
      List<dynamic> myGroups = [];
      try {
        final scopeRes = await http.get(
          Uri.parse('$baseUrl/scope-groups/my-scope'),
          headers: headers,
        );
        if (scopeRes.statusCode == 200) {
          final scopeData = json.decode(scopeRes.body);
          if (scopeData is Map) {
            myGroups = List.from(scopeData['allScopeGroups'] ?? scopeData['scopeGroups'] ?? []);
            if (scopeData['isDeveloper'] == true) _isDeveloper = true;
          }
        }
      } catch (_) {}

      // 2. Fetch all scope groups
      try {
        final groupsRes = await http.get(
          Uri.parse('$baseUrl/scope-groups'),
          headers: headers,
        );
        if (groupsRes.statusCode == 200) {
          final allGroups = json.decode(groupsRes.body);
          if (allGroups is List && allGroups.isNotEmpty) {
            _scopeGroups = allGroups;
          } else {
            _scopeGroups = myGroups;
          }
        } else {
          _scopeGroups = myGroups;
        }
      } catch (_) {
        _scopeGroups = myGroups;
      }

      // 3. Fetch Gates scoped to user
      final gatesRes = await http.get(
        Uri.parse('$baseUrl/lcgate'),
        headers: headers,
      );
      if (gatesRes.statusCode == 200) {
        final gatesData = json.decode(gatesRes.body);
        _gates = gatesData is List ? gatesData : [];
      } else {
        _gates = [];
      }

      if (mounted) {
        setState(() => _isLoading = false);
        if (isManual) {
          AppFeedback.showSuccess(context, 'LC Gates directory refreshed.');
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() => _isLoading = false);
        AppFeedback.showError(context, 'Failed to load LC Gates data: $e');
      }
    }
  }

  // Recursive cluster count for scope group
  int _getRecursiveClusterCount(int groupId) {
    final descendantIds = <int>{groupId};
    final queue = <int>[groupId];

    while (queue.isNotEmpty) {
      final current = queue.removeAt(0);
      for (final g in _scopeGroups) {
        if (g is Map && g['parentId'] == current) {
          final childId = g['id'];
          if (childId is int && !descendantIds.contains(childId)) {
            descendantIds.add(childId);
            queue.add(childId);
          }
        }
      }
    }

    int count = 0;
    for (final gate in _gates) {
      if (gate is Map) {
        final sgs = gate['scopeGroups'] as List?;
        if (sgs != null) {
          final matches = sgs.any((item) {
            final gid = item['scopeGroupId'] ?? item['scopeGroup']?['id'];
            return gid != null && descendantIds.contains(gid);
          });
          if (matches) count++;
        }
      }
    }
    return count;
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
    if (_viewMode == 'flat') {
      if (_searchQuery.trim().isEmpty) return _gates;
      final q = _searchQuery.toLowerCase().trim();
      return _gates.where((g) {
        if (g is! Map) return false;
        final lc = (g['lcNumber'] ?? '').toString().toLowerCase();
        final name = (g['name'] ?? '').toString().toLowerCase();
        final loc = (g['locationName'] ?? '').toString().toLowerCase();
        final zone = (g['zone'] ?? '').toString().toLowerCase();
        final div = (g['division'] ?? '').toString().toLowerCase();
        return lc.contains(q) || name.contains(q) || loc.contains(q) || zone.contains(q) || div.contains(q);
      }).toList();
    }

    final curId = _currentFolderId;
    if (curId == null) return [];

    var result = _gates.where((g) {
      if (g is! Map) return false;
      final sgs = g['scopeGroups'] as List?;
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
        return lc.contains(q) || name.contains(q) || loc.contains(q);
      }).toList();
    }
    return result;
  }

  // Extract first evidence photo for a gate
  Map<String, dynamic>? _getGateInstallationEvidence(Map<String, dynamic> gate) {
    final masters = gate['masters'] as List?;
    if (masters == null) return null;

    for (final m in masters) {
      if (m is Map) {
        final evidences = m['evidences'] as List?;
        if (evidences != null && evidences.isNotEmpty) {
          return {
            'evidence': evidences[0],
            'masterSeq': m['masterSequence'],
          };
        }

        final children = m['childDevices'] as List?;
        if (children != null) {
          for (final c in children) {
            if (c is Map) {
              final cEvidences = c['evidences'] as List?;
              if (cEvidences != null && cEvidences.isNotEmpty) {
                return {
                  'evidence': cEvidences[0],
                  'masterSeq': m['masterSequence'],
                  'deviceSeq': c['deviceSequence'],
                };
              }
            }
          }
        }
      }
    }
    return null;
  }

  // Total hardware devices count for selected gate
  int _getTotalDevicesCount(Map<String, dynamic>? gate) {
    if (gate == null) return 0;
    final masters = gate['masters'] as List?;
    if (masters == null) return 0;
    int count = masters.length;
    for (final m in masters) {
      if (m is Map) {
        final children = m['childDevices'] as List?;
        if (children != null) count += children.length;
      }
    }
    return count;
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
    });
  }

  // Open Evidence Photo Dialog
  void _showEvidenceDialog({
    required Map<String, dynamic> gate,
    required Map<String, dynamic> evidence,
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
                // Modal Header
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
                      const Expanded(
                        child: Text(
                          'Installation Evidence Photo',
                          style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
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

                // Photo Preview
                Container(
                  color: const Color(0xFF0F172A),
                  constraints: const BoxConstraints(maxHeight: 340),
                  child: imgUrl.isNotEmpty
                      ? Image.network(
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
                        )
                      : const Padding(
                          padding: EdgeInsets.all(40),
                          child: Center(child: Text('No image URL', style: TextStyle(color: Colors.white70))),
                        ),
                ),

                // Metadata Details
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildMetaRow(
                        'Cluster & LC Number',
                        '${gate['lcNumber']} (${gate['locationName'] ?? gate['name'] ?? 'Cluster'})',
                      ),
                      const Divider(height: 16),
                      _buildMetaRow(
                        'Hardware Association',
                        'Master #${masterSeq ?? 1}${deviceSeq != null ? ' • Slave #$deviceSeq' : ''}',
                      ),
                      const Divider(height: 16),
                      _buildMetaRow(
                        'Geotag (GPS)',
                        lat != null && lng != null
                            ? '${(lat as num).toStringAsFixed(6)}° N, ${(lng as num).toStringAsFixed(6)}° E'
                            : 'Coordinates recorded during installation',
                      ),
                      const Divider(height: 16),
                      _buildMetaRow(
                        'Upload Timestamp',
                        createdAt != null && createdAt.isNotEmpty
                            ? createdAt.replaceFirst('T', ' ').split('.').first
                            : 'Recorded at Commissioning',
                      ),
                      const SizedBox(height: 16),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 12),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                          ),
                          onPressed: () => Navigator.pop(ctx),
                          child: const Text('Close'),
                        ),
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

  Widget _buildMetaRow(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
        const SizedBox(height: 2),
        Text(value, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFF0F172A))),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      body: _isLoading
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
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // 1. Clean Header Banner
                    _buildHeaderBanner(),
                    const SizedBox(height: 14),

                    // 2. Navigation & Toolbar
                    _buildNavigationToolbar(),
                    const SizedBox(height: 16),

                    // 3. Main Views
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
  // 1. CLEAN & LIGHTWEIGHT HEADER BANNER
  // ==========================================================
  Widget _buildHeaderBanner() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: const [
          BoxShadow(color: Color(0x08000000), offset: Offset(0, 1), blurRadius: 3),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Icon(Icons.meeting_room_outlined, color: AppColors.primary, size: 20),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'LC Gates & Clusters Directory',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Organized hierarchy of railway clusters and gates based on your designated Zonal and Division Scope Groups.',
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600, height: 1.3),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),

          // Chips Row
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: const Color(0xFFF8FAFC),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.folder_outlined, size: 14, color: AppColors.primary),
                    const SizedBox(width: 6),
                    Text(
                      'Scope Groups: ${_scopeGroups.length}',
                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155)),
                    ),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: const Color(0xFFF8FAFC),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.device_hub_outlined, size: 14, color: AppColors.primary),
                    const SizedBox(width: 6),
                    Text(
                      'Clusters: ${_gates.length}',
                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155)),
                    ),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: const Color(0xFFEFF6FF),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFFBFDBFE)),
                ),
                child: Text(
                  _isDeveloper ? 'Developer Full Access' : 'Role: ${widget.user['role'] ?? 'Scoped Operator'}',
                  style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ==========================================================
  // 2. NAVIGATION & TOOLBAR (Breadcrumbs, Search, View Toggle)
  // ==========================================================
  Widget _buildNavigationToolbar() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: const [
          BoxShadow(color: Color(0x08000000), offset: Offset(0, 1), blurRadius: 3),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Breadcrumbs
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
                          Icon(
                            i == 0 ? Icons.folder_outlined : Icons.folder_open,
                            size: 13,
                            color: i == 0 ? AppColors.primary : parseHexColor(_breadcrumbs[i]['color']),
                          ),
                          const SizedBox(width: 5),
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
          const SizedBox(height: 12),

          // Search Field
          TextField(
            controller: _searchCtrl,
            onChanged: (val) => setState(() => _searchQuery = val),
            style: const TextStyle(fontSize: 13),
            decoration: InputDecoration(
              hintText: 'Search folders or gates...',
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
          const SizedBox(height: 10),

          // View Mode Switcher + Refresh Button
          Row(
            children: [
              Expanded(
                child: Row(
                  children: [
                    Expanded(
                      child: InkWell(
                        onTap: () => setState(() {
                          _viewMode = 'folder';
                          _selectedGate = null;
                        }),
                        borderRadius: BorderRadius.circular(6),
                        child: Container(
                          padding: const EdgeInsets.symmetric(vertical: 7),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: _viewMode == 'folder' ? AppColors.primary : const Color(0xFFF1F5F9),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.folder_outlined, size: 14, color: _viewMode == 'folder' ? Colors.white : const Color(0xFF475569)),
                              const SizedBox(width: 5),
                              Text(
                                'Folder Explorer',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.bold,
                                  color: _viewMode == 'folder' ? Colors.white : const Color(0xFF475569),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: InkWell(
                        onTap: () => setState(() {
                          _viewMode = 'flat';
                          _selectedGate = null;
                        }),
                        borderRadius: BorderRadius.circular(6),
                        child: Container(
                          padding: const EdgeInsets.symmetric(vertical: 7),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: _viewMode == 'flat' ? AppColors.primary : const Color(0xFFF1F5F9),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.grid_view_rounded, size: 14, color: _viewMode == 'flat' ? Colors.white : const Color(0xFF475569)),
                              const SizedBox(width: 5),
                              Text(
                                'All Clusters',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.bold,
                                  color: _viewMode == 'flat' ? Colors.white : const Color(0xFF475569),
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
              const SizedBox(width: 8),
              IconButton(
                style: IconButton.styleFrom(
                  backgroundColor: const Color(0xFFF1F5F9),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                  padding: const EdgeInsets.all(7),
                ),
                icon: const Icon(Icons.refresh, size: 16, color: Color(0xFF475569)),
                tooltip: 'Refresh directory',
                onPressed: () => _fetchData(isManual: true),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ==========================================================
  // 3. DIRECTORY VIEW: FOLDERS + CLUSTERS
  // ==========================================================
  Widget _buildDirectoryView() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Folders Section (Only in Folder Explorer mode)
        if (_viewMode == 'folder') ...[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  const Icon(Icons.folder_open, size: 18, color: AppColors.primary),
                  const SizedBox(width: 6),
                  Text(
                    _currentFolderId == null
                        ? 'Scope Groups (Zonal & Divisional)'
                        : 'Sub-Divisions in ${_breadcrumbs.last['name']}',
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: const Color(0xFFE2E8F0),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      '${_currentFolders.length}',
                      style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF334155)),
                    ),
                  ),
                ],
              ),
              if (_currentFolderId != null)
                TextButton.icon(
                  style: TextButton.styleFrom(padding: EdgeInsets.zero, visualDensity: VisualDensity.compact),
                  onPressed: () => _jumpBreadcrumb(_breadcrumbs.length - 2),
                  icon: const Icon(Icons.arrow_upward, size: 14),
                  label: const Text('Up One Level', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                ),
            ],
          ),
          const SizedBox(height: 10),

          if (_currentFolders.isEmpty)
            _buildEmptyCard(
              icon: Icons.layers_outlined,
              title: _currentFolderId == null ? 'No Scope Groups Found' : 'No Sub-Divisions Configured',
              message: _currentFolderId == null
                  ? (_searchQuery.isNotEmpty ? 'No scope groups match your filter.' : 'No scope groups are configured.')
                  : 'This scope group has no sub-divisions. All assigned clusters are listed below.',
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: _currentFolders.length,
              separatorBuilder: (context, index) => const SizedBox(height: 10),
              itemBuilder: (context, index) {
                final folder = _currentFolders[index] as Map<String, dynamic>;
                return _buildFolderCard(folder);
              },
            ),
          const SizedBox(height: 20),
        ],

        // Clusters Section
        Row(
          children: [
            const Icon(Icons.meeting_room_outlined, size: 18, color: AppColors.primary),
            const SizedBox(width: 6),
            Text(
              _viewMode == 'flat'
                  ? 'All Accessible Railway Clusters'
                  : _currentFolderId == null
                      ? 'Root Level Clusters'
                      : 'Clusters in ${_breadcrumbs.last['name']}',
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: const Color(0xFFE2E8F0),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                '${_currentClusters.length}',
                style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF334155)),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),

        if (_currentClusters.isEmpty)
          _buildEmptyCard(
            icon: Icons.meeting_room_outlined,
            title: _viewMode == 'folder' && _currentFolderId == null
                ? 'Select a Scope Group Above'
                : 'No Clusters Found in this Scope Group',
            message: _viewMode == 'folder' && _currentFolderId == null
                ? 'Tap any Zonal or Divisional Scope Group card above to inspect clusters defined within it.'
                : _searchQuery.isNotEmpty
                    ? 'No clusters match your search query.'
                    : 'No gates have been directly mapped to this Scope Group yet.',
          )
        else
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: _currentClusters.length,
            separatorBuilder: (context, index) => const SizedBox(height: 12),
            itemBuilder: (context, index) {
              final gate = _currentClusters[index] as Map<String, dynamic>;
              return _buildClusterCard(gate);
            },
          ),
      ],
    );
  }

  // Folder Card
  Widget _buildFolderCard(Map<String, dynamic> folder) {
    final folderColor = parseHexColor(folder['color']);
    final children = folder['children'] as List?;
    final subGroupCount = children?.length ?? folder['_count']?['children'] ?? 0;
    final clusterCount = _getRecursiveClusterCount(folder['id']);
    final desc = folder['description']?.toString();
    final parent = folder['parent'] as Map<String, dynamic>?;

    return InkWell(
      onTap: () => _openFolder(folder),
      borderRadius: BorderRadius.circular(12),
      child: Container(
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
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: folderColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(Icons.folder, color: folderColor, size: 20),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        folder['name'] ?? 'Scope Group',
                        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                      ),
                      Text(
                        parent != null ? '${parent['name']} / ${folder['name']}' : '/${folder['name']}',
                        style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, color: Color(0xFF94A3B8), size: 20),
              ],
            ),
            if (desc != null && desc.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(desc, style: const TextStyle(fontSize: 12, color: Color(0xFF475569)), maxLines: 2, overflow: TextOverflow.ellipsis),
            ],
            const SizedBox(height: 10),

            // Pills Footer
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                if (subGroupCount > 0)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF1F5F9),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.create_new_folder_outlined, size: 11, color: Color(0xFF475569)),
                        const SizedBox(width: 4),
                        Text('$subGroupCount Sub-Divisions', style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF475569))),
                      ],
                    ),
                  ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFFEFF6FF),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.device_hub_outlined, size: 11, color: Color(0xFF1D4ED8)),
                      const SizedBox(width: 4),
                      Text(
                        '$clusterCount ${clusterCount == 1 ? "Cluster" : "Clusters"}',
                        style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8)),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  // Cluster Card
  Widget _buildClusterCard(Map<String, dynamic> gate) {
    final masters = gate['masters'] as List?;
    final masterCount = masters?.length ?? 0;
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

    final evidenceInfo = _getGateInstallationEvidence(gate);
    final lat = gate['latitude'];
    final lng = gate['longitude'];

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
                // Top Row: LC Badge + Power Pill
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFF0F172A),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.meeting_room_outlined, size: 12, color: Colors.white),
                          const SizedBox(width: 5),
                          Text(
                            gate['lcNumber'] ?? 'LC-GATE',
                            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.white),
                          ),
                        ],
                      ),
                    ),
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
                const SizedBox(height: 10),

                // Cluster Name
                Text(
                  gate['name'] ?? gate['locationName'] ?? 'Cluster Gate',
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
                ),
                const SizedBox(height: 4),

                // Zone & Division & GPS
                Row(
                  children: [
                    const Icon(Icons.train_outlined, size: 12, color: Color(0xFF64748B)),
                    const SizedBox(width: 4),
                    Text(
                      '${gate['zone'] ?? 'CR'} / ${gate['division'] ?? 'Mumbai'}',
                      style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                    ),
                    if (lat != null && lng != null) ...[
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 6),
                        child: Text('•', style: TextStyle(color: Color(0xFF94A3B8))),
                      ),
                      InkWell(
                        onTap: () {
                          Clipboard.setData(ClipboardData(text: '$lat, $lng'));
                          AppFeedback.showSuccess(context, 'Coordinates $lat, $lng copied to clipboard.');
                        },
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.location_on, size: 12, color: Color(0xFFEF4444)),
                            const SizedBox(width: 2),
                            Text(
                              '${(lat as num).toStringAsFixed(4)}, ${(lng as num).toStringAsFixed(4)}',
                              style: const TextStyle(fontSize: 11, color: Color(0xFF0284C7), fontWeight: FontWeight.bold),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 12),

                // Device summary chips
                Row(
                  children: [
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF8FAFC),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFE2E8F0)),
                        ),
                        child: Row(
                          children: [
                            Text(
                              '$masterCount',
                              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: AppColors.primary),
                            ),
                            const SizedBox(width: 6),
                            const Text('Master Units', style: TextStyle(fontSize: 11, color: Color(0xFF475569))),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF8FAFC),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFE2E8F0)),
                        ),
                        child: Row(
                          children: [
                            Text(
                              '$slaveCount',
                              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: AppColors.primary),
                            ),
                            const SizedBox(width: 6),
                            const Text('Slave Sensors', style: TextStyle(fontSize: 11, color: Color(0xFF475569))),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),

                // Installation evidence preview
                if (evidenceInfo != null) ...[
                  const SizedBox(height: 12),
                  InkWell(
                    onTap: () => _showEvidenceDialog(
                      gate: gate,
                      evidence: evidenceInfo['evidence'],
                      masterSeq: evidenceInfo['masterSeq'],
                      deviceSeq: evidenceInfo['deviceSeq'],
                    ),
                    borderRadius: BorderRadius.circular(8),
                    child: Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF8FAFC),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFE2E8F0)),
                      ),
                      child: Row(
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(6),
                            child: SizedBox(
                              width: 44,
                              height: 44,
                              child: Image.network(
                                getFullImageUrl(evidenceInfo['evidence']['imageUrl']?.toString()),
                                fit: BoxFit.cover,
                                errorBuilder: (context, error, stackTrace) => Container(
                                  color: Colors.grey.shade200,
                                  child: const Icon(Icons.camera_alt_outlined, color: Colors.grey, size: 20),
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'Installation Evidence',
                                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                ),
                                Text(
                                  evidenceInfo['evidence']['latitude'] != null
                                      ? 'GPS: ${(evidenceInfo['evidence']['latitude'] as num).toStringAsFixed(4)}, ${(evidenceInfo['evidence']['longitude'] as num).toStringAsFixed(4)}'
                                      : 'Site Photo Attached',
                                  style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                                ),
                              ],
                            ),
                          ),
                          const Icon(Icons.visibility_outlined, size: 16, color: Color(0xFF0284C7)),
                        ],
                      ),
                    ),
                  ),
                ],
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
                    icon: const Icon(Icons.sensors, size: 14, color: Colors.white),
                    label: const Text('AWS Telemetry', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.white)),
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
  // 4. CLUSTER DRILLDOWN (DETAIL VIEW)
  // ==========================================================
  Widget _buildDetailView() {
    final gate = _selectedGate!;
    final masters = gate['masters'] as List?;
    final isSolar = masters?.any((m) => m is Map && m['powerSource'] == 'SOLAR') ?? false;
    final lat = gate['latitude'];
    final lng = gate['longitude'];
    final scopeGroups = gate['scopeGroups'] as List?;
    final totalDevs = _getTotalDevicesCount(gate);

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
              onPressed: () => setState(() {
                _viewMode = 'folder';
                _selectedGate = null;
              }),
              icon: const Icon(Icons.arrow_back, size: 16),
              label: const Text('Back to Directory', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                InkWell(
                  onTap: () => DeviceInfoSheet.show(context, gate: gate),
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
                        Icon(Icons.developer_board, size: 12, color: Color(0xFF1D4ED8)),
                        SizedBox(width: 4),
                        Text('Device Info', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8))),
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
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0F172A),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      gate['lcNumber'] ?? 'LC-GATE',
                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      gate['name'] ?? gate['locationName'] ?? 'Cluster',
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),

              Row(
                children: [
                  const Icon(Icons.train_outlined, size: 13, color: Color(0xFF64748B)),
                  const SizedBox(width: 4),
                  Text(
                    'Zone: ${gate['zone'] ?? 'CR'} • Division: ${gate['division'] ?? 'Mumbai'}',
                    style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                  ),
                ],
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
                          const Icon(Icons.folder_outlined, size: 10, color: Color(0xFF1D4ED8)),
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

        // Detail Tabs Switcher
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
                  onTap: () => setState(() => _clusterTab = 'about'),
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
                            'About Cluster & Hardware',
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
                  onTap: () => setState(() => _clusterTab = 'telemetry'),
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
                        Icon(Icons.sensors, size: 14, color: _clusterTab == 'telemetry' ? AppColors.primary : const Color(0xFF64748B)),
                        const SizedBox(width: 5),
                        Flexible(
                          child: Text(
                            'AWS Telemetry',
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
          _buildTelemetryTab(gate, totalDevs),
      ],
    );
  }

  // Tab 1: About Cluster & Hardware
  Widget _buildAboutTab(Map<String, dynamic> gate, bool isSolar, dynamic lat, dynamic lng) {
    final masters = (gate['masters'] as List?) ?? [];
    int slaveCount = 0;
    for (final m in masters) {
      if (m is Map) {
        final children = m['childDevices'] as List?;
        if (children != null) slaveCount += children.length;
      }
    }
    final evidenceInfo = _getGateInstallationEvidence(gate);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Geographical Location Card
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

        // Hardware Configuration Card
        _buildSectionCard(
          title: 'Hardware Configuration',
          icon: Icons.memory,
          iconColor: AppColors.primary,
          children: [
            _buildFieldRow('Primary Power', isSolar ? 'Solar Powered' : 'Direct AC Mains'),
            _buildFieldRow('Configured Masters', '${masters.length} Gateway Unit(s)'),
            _buildFieldRow('Connected Slave Sensors', '$slaveCount Device(s)'),
            _buildFieldRow('System Status', 'Configured (Active)'),
          ],
        ),
        const SizedBox(height: 14),

        // Installation Evidence Card
        _buildSectionCard(
          title: 'Installation Evidence',
          icon: Icons.camera_alt_outlined,
          iconColor: AppColors.primary,
          children: [
            if (evidenceInfo != null) ...[
              InkWell(
                onTap: () => _showEvidenceDialog(
                  gate: gate,
                  evidence: evidenceInfo['evidence'],
                  masterSeq: evidenceInfo['masterSeq'],
                  deviceSeq: evidenceInfo['deviceSeq'],
                ),
                child: Row(
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: SizedBox(
                        width: 54,
                        height: 54,
                        child: Image.network(
                          getFullImageUrl(evidenceInfo['evidence']['imageUrl']?.toString()),
                          fit: BoxFit.cover,
                          errorBuilder: (context, error, stackTrace) => Container(
                            color: Colors.grey.shade200,
                            child: const Icon(Icons.broken_image, color: Colors.grey),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Equipment Photo', style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Color(0xFF0F172A))),
                          Text(
                            evidenceInfo['evidence']['latitude'] != null
                                ? 'GPS: ${(evidenceInfo['evidence']['latitude'] as num).toStringAsFixed(4)}, ${(evidenceInfo['evidence']['longitude'] as num).toStringAsFixed(4)}'
                                : 'Site Photo Attached',
                            style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                          ),
                          Text(
                            'Master #${evidenceInfo['masterSeq'] ?? 1}${evidenceInfo['deviceSeq'] != null ? ' • Slave #${evidenceInfo['deviceSeq']}' : ''}',
                            style: const TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(36),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                ),
                icon: const Icon(Icons.zoom_in, size: 16),
                label: const Text('View Full Photo', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                onPressed: () => _showEvidenceDialog(
                  gate: gate,
                  evidence: evidenceInfo['evidence'],
                  masterSeq: evidenceInfo['masterSeq'],
                  deviceSeq: evidenceInfo['deviceSeq'],
                ),
              ),
            ] else
              Container(
                padding: const EdgeInsets.all(12),
                alignment: Alignment.center,
                decoration: BoxDecoration(color: const Color(0xFFF8FAFC), borderRadius: BorderRadius.circular(8)),
                child: const Text('No installation evidence photo uploaded yet.', style: TextStyle(fontSize: 12, color: Color(0xFF64748B))),
              ),
          ],
        ),
        const SizedBox(height: 18),

        // Topology Section
        const Text(
          'Configured Hardware Devices Topology',
          style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
        ),
        const SizedBox(height: 10),

        if (masters.isEmpty)
          _buildEmptyCard(
            icon: Icons.memory,
            title: 'No Master Devices Configured',
            message: 'This cluster currently does not have master hardware units configured.',
          )
        else
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: masters.length,
            separatorBuilder: (context, index) => const SizedBox(height: 12),
            itemBuilder: (context, index) {
              final master = masters[index] as Map<String, dynamic>;
              final mEvidences = (master['evidences'] as List?) ?? [];
              final mEvidence = mEvidences.isNotEmpty ? mEvidences[0] : null;
              final childDevices = (master['childDevices'] as List?) ?? [];

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
                    // Master Header
                    Row(
                      children: [
                        Container(
                          width: 34,
                          height: 34,
                          decoration: BoxDecoration(
                            color: const Color(0xFFE0F2FE),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: const Icon(Icons.memory, color: Color(0xFF0369A1), size: 18),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Master #${master['masterSequence']}: ${master['serialNumber']}',
                                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                overflow: TextOverflow.ellipsis,
                              ),
                              Text(
                                'Primary Gateway • ${master['powerSource'] == 'SOLAR' ? 'Solar Powered' : 'Direct AC Power'}',
                                style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 6),
                        InkWell(
                          onTap: () => DeviceInfoSheet.show(context, master: master, gate: gate),
                          borderRadius: BorderRadius.circular(6),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
                            decoration: BoxDecoration(
                              color: const Color(0xFFEFF6FF),
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: const Color(0xFFBFDBFE)),
                            ),
                            child: const Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.developer_board, size: 12, color: Color(0xFF1D4ED8)),
                                SizedBox(width: 4),
                                Text('Info', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8))),
                              ],
                            ),
                          ),
                        ),
                        if (mEvidence != null) ...[
                          const SizedBox(width: 6),
                          InkWell(
                            onTap: () => _showEvidenceDialog(
                              gate: gate,
                              evidence: mEvidence,
                              masterSeq: master['masterSequence'],
                            ),
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(6),
                              child: SizedBox(
                                width: 34,
                                height: 34,
                                child: Image.network(
                                  getFullImageUrl(mEvidence['imageUrl']?.toString()),
                                  fit: BoxFit.cover,
                                  errorBuilder: (context, error, stackTrace) => const Icon(Icons.broken_image, size: 16),
                                ),
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 12),

                    // Slaves Sub-section
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF8FAFC),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFF1F5F9)),
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
                                style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF475569)),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),

                          if (childDevices.isEmpty)
                            const Text('No slave devices linked to this master.', style: TextStyle(fontSize: 11, color: Color(0xFF94A3B8)))
                          else
                            ListView.separated(
                              shrinkWrap: true,
                              physics: const NeverScrollableScrollPhysics(),
                              itemCount: childDevices.length,
                              separatorBuilder: (context, index) => const SizedBox(height: 6),
                              itemBuilder: (context, cIdx) {
                                final child = childDevices[cIdx] as Map<String, dynamic>;
                                final cEvs = (child['evidences'] as List?) ?? [];
                                final cEv = cEvs.isNotEmpty ? cEvs[0] : null;

                                return Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    borderRadius: BorderRadius.circular(6),
                                    border: Border.all(color: const Color(0xFFE2E8F0)),
                                  ),
                                  child: Row(
                                    children: [
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              child['serialNumber'] ?? 'Slave',
                                              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                            Text(
                                              '${child['type'] ?? 'Device'} • Sequence #${child['deviceSequence']}',
                                              style: const TextStyle(fontSize: 10, color: Color(0xFF64748B)),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ],
                                        ),
                                      ),
                                      const SizedBox(width: 6),
                                      InkWell(
                                        onTap: () => DeviceInfoSheet.show(context, device: child, master: master, gate: gate),
                                        borderRadius: BorderRadius.circular(4),
                                        child: Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2.5),
                                          decoration: BoxDecoration(
                                            color: const Color(0xFFEFF6FF),
                                            borderRadius: BorderRadius.circular(4),
                                            border: Border.all(color: const Color(0xFFBFDBFE)),
                                          ),
                                          child: const Text('Info', style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8))),
                                        ),
                                      ),
                                      if (cEv != null) ...[
                                        const SizedBox(width: 6),
                                        InkWell(
                                          onTap: () => _showEvidenceDialog(
                                            gate: gate,
                                            evidence: cEv,
                                            masterSeq: master['masterSequence'],
                                            deviceSeq: child['deviceSequence'],
                                          ),
                                          child: ClipRRect(
                                            borderRadius: BorderRadius.circular(4),
                                            child: SizedBox(
                                              width: 28,
                                              height: 28,
                                              child: Image.network(
                                                getFullImageUrl(cEv['imageUrl']?.toString()),
                                                fit: BoxFit.cover,
                                                errorBuilder: (context, error, stackTrace) => const Icon(Icons.broken_image, size: 14),
                                              ),
                                            ),
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
              );
            },
          ),
      ],
    );
  }

  // Tab 2: AWS Telemetry & Fleet Provisioning
  Widget _buildTelemetryTab(Map<String, dynamic> gate, int totalDevicesCount) {
    final masters = (gate['masters'] as List?) ?? [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Informational Banner
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: const Color(0xFFEFF6FF),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFBFDBFE)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFF1D4ED8),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.sensors, size: 12, color: Colors.white),
                        SizedBox(width: 4),
                        Text(
                          'AWS IoT Core • Fleet Provisioning',
                          style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.white),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFEF3C7),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: const Color(0xFFFDE68A)),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.schedule, size: 12, color: Color(0xFFD97706)),
                        SizedBox(width: 4),
                        Text(
                          'Upcoming AWS Integration',
                          style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFFD97706)),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              const Text(
                'AWS Device Telemetry & Fleet Mapping',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
              ),
              const SizedBox(height: 4),
              const Text(
                'Hardware devices configured for this cluster will be mapped and provisioned directly into AWS IoT Core using AWS Fleet Provisioning. Once provisioned and active on AWS, live device payloads and operational telemetry will stream directly from the physical hardware.',
                style: TextStyle(fontSize: 11, color: Color(0xFF334155), height: 1.4),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),

        // Configured Devices Section
        Container(
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
              Wrap(
                spacing: 8,
                runSpacing: 8,
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.memory, size: 16, color: AppColors.primary),
                      const SizedBox(width: 6),
                      Text(
                        'Configured Hardware Units ($totalDevicesCount)',
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: Color(0xFF0F172A)),
                      ),
                    ],
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFEF3C7),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: const Color(0xFFFDE68A)),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.schedule, size: 10, color: Color(0xFFD97706)),
                        SizedBox(width: 4),
                        Text(
                          'Pending Fleet Provisioning',
                          style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Color(0xFFD97706)),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),

              if (masters.isEmpty)
                _buildEmptyCard(
                  icon: Icons.memory,
                  title: 'No Hardware Units Configured',
                  message: 'No Master or Slave devices have been registered for this cluster yet.',
                )
              else
                ListView.separated(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: masters.length,
                  separatorBuilder: (context, index) => const SizedBox(height: 10),
                  itemBuilder: (context, mIdx) {
                    final master = masters[mIdx] as Map<String, dynamic>;
                    final childDevices = (master['childDevices'] as List?) ?? [];

                    return Column(
                      children: [
                        // Master Unit Row
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
                              Row(
                                children: [
                                  Container(
                                    width: 32,
                                    height: 32,
                                    decoration: BoxDecoration(
                                      color: const Color(0xFF0369A1),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: const Icon(Icons.memory, color: Colors.white, size: 16),
                                  ),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          master['serialNumber'] ?? 'Master',
                                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                        Text(
                                          'Sequence #${master['masterSequence']} • Primary Master Gateway',
                                          style: const TextStyle(fontSize: 10, color: Color(0xFF64748B)),
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ],
                                    ),
                                  ),
                                  const SizedBox(width: 6),
                                  InkWell(
                                    onTap: () => DeviceInfoSheet.show(context, master: master, gate: gate),
                                    borderRadius: BorderRadius.circular(6),
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                                      decoration: BoxDecoration(
                                        color: const Color(0xFFEFF6FF),
                                        borderRadius: BorderRadius.circular(5),
                                        border: Border.all(color: const Color(0xFFBFDBFE)),
                                      ),
                                      child: const Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(Icons.developer_board, size: 11, color: Color(0xFF1D4ED8)),
                                          SizedBox(width: 3),
                                          Text('Info', style: TextStyle(fontSize: 9, fontWeight: FontWeight.w700, color: Color(0xFF1D4ED8))),
                                        ],
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 6),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                                    decoration: BoxDecoration(
                                      color: master['powerSource'] == 'SOLAR' ? const Color(0xFFFEF3C7) : const Color(0xFFDBEAFE),
                                      borderRadius: BorderRadius.circular(5),
                                    ),
                                    child: Text(
                                      master['powerSource'] == 'SOLAR' ? 'Solar' : 'Direct AC',
                                      style: TextStyle(
                                        fontSize: 9,
                                        fontWeight: FontWeight.bold,
                                        color: master['powerSource'] == 'SOLAR' ? const Color(0xFFD97706) : const Color(0xFF2563EB),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 8),
                              const Divider(height: 1, color: Color(0xFFE2E8F0)),
                              const SizedBox(height: 8),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  const Text('AWS Fleet Status:', style: TextStyle(fontSize: 10, color: Color(0xFF64748B))),
                                  Flexible(
                                    child: Text(
                                      'Pending Fleet Provisioning',
                                      style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFFD97706)),
                                      overflow: TextOverflow.ellipsis,
                                      textAlign: TextAlign.end,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 3),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  const Text('Live Telemetry:', style: TextStyle(fontSize: 10, color: Color(0xFF64748B))),
                                  Flexible(
                                    child: Text(
                                      'Awaiting AWS IoT connection',
                                      style: const TextStyle(fontSize: 10, fontStyle: FontStyle.italic, color: Color(0xFF94A3B8)),
                                      overflow: TextOverflow.ellipsis,
                                      textAlign: TextAlign.end,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),

                        // Slaves under this Master
                        if (childDevices.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Padding(
                            padding: const EdgeInsets.only(left: 14),
                            child: Column(
                              children: childDevices.map((c) {
                                final child = c as Map<String, dynamic>;
                                return Container(
                                  margin: const EdgeInsets.only(bottom: 6),
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(color: const Color(0xFFE2E8F0)),
                                  ),
                                  child: Row(
                                    children: [
                                      const Icon(Icons.power_outlined, size: 14, color: Color(0xFF0284C7)),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              child['serialNumber'] ?? 'Slave',
                                              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                            Text(
                                              'Slave #${child['deviceSequence']} • ${child['type'] ?? 'Sensor / Actuator'}',
                                              style: const TextStyle(fontSize: 9, color: Color(0xFF64748B)),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ],
                                        ),
                                      ),
                                      const SizedBox(width: 6),
                                      InkWell(
                                        onTap: () => DeviceInfoSheet.show(context, device: child, master: master, gate: gate),
                                        borderRadius: BorderRadius.circular(4),
                                        child: Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2.5),
                                          decoration: BoxDecoration(
                                            color: const Color(0xFFEFF6FF),
                                            borderRadius: BorderRadius.circular(4),
                                            border: Border.all(color: const Color(0xFFBFDBFE)),
                                          ),
                                          child: const Text('Info', style: TextStyle(fontSize: 8.5, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8))),
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      const Text(
                                        'Awaiting AWS',
                                        style: TextStyle(fontSize: 9, fontStyle: FontStyle.italic, color: Color(0xFF94A3B8)),
                                      ),
                                    ],
                                  ),
                                );
                              }).toList(),
                            ),
                          ),
                        ],
                      ],
                    );
                  },
                ),
            ],
          ),
        ),
      ],
    );
  }

  // Helper Section Card for About Tab
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
}
