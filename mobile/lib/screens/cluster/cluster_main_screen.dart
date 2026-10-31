import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'create_gate_screen.dart';
import 'gate_detail_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import '../../components/device_info_sheet.dart';
import 'railway_data.dart';
import '../../services/lc_gates_cache_service.dart';

class ClusterMainScreen extends StatefulWidget {
  final Map<String, dynamic>? user;
  const ClusterMainScreen({super.key, this.user});

  @override
  State<ClusterMainScreen> createState() => _ClusterMainScreenState();
}

class _ClusterMainScreenState extends State<ClusterMainScreen> {
  List<dynamic> _gates = [];
  bool _isLoading = true;
  String? _errorMessage;
  String _token = '';
  String _userId = 'user';
  List<String> _scopeNames = [];

  // Developer Scope Groups View State (Parity with Web ClusterDashboard)
  String _developerScopeId = '';
  List<dynamic> _allScopeGroupsList = [];

  // Zone/Division reference data
  List<String> _zones = RailwayData.zones;
  Map<String, List<String>> _divisionsByZone = RailwayData.data;

  // Filters & sort
  String _filterZone = '';
  String _filterDivision = '';
  String _filterLocation = '';
  String _filterName = '';
  String _filterLc = '';
  String _sortBy = 'newest';

  static const List<Map<String, String>> _sortOptions = [
    {'value': 'newest', 'label': 'Newest First'},
    {'value': 'name_asc', 'label': 'Gate Name (A–Z)'},
    {'value': 'name_desc', 'label': 'Gate Name (Z–A)'},
    {'value': 'lc_asc', 'label': 'LC Number (Ascending)'},
    {'value': 'zone_asc', 'label': 'Zone (A–Z)'},
    {'value': 'location_asc', 'label': 'Location (A–Z)'},
  ];

  bool get _isDeveloper =>
      widget.user?['role'] == 'Developer' ||
      ((widget.user?['allowedModules'] as List?)?.contains('cluster') ?? false);

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token') ?? '';
    final userId = (widget.user?['id'] ?? prefs.getString('userId') ?? prefs.getString('employeeId') ?? 'user').toString();
    if (!mounted) return;
    setState(() {
      _token = token;
      _userId = userId;
    });
    await _fetchGates();
    await _fetchReferenceData();
    await _fetchMyScope();
    await _fetchScopeGroupsForDeveloper();
  }

  Future<void> _fetchScopeGroupsForDeveloper() async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/scope-groups'),
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is List && mounted) {
          setState(() => _allScopeGroupsList = data);
        }
      }
    } catch (_) {}
  }

  Future<void> _fetchMyScope() async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/scope-groups/my-scope'),
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map && data['scopeGroups'] is List) {
          final list = (data['scopeGroups'] as List)
              .map((g) => (g['name'] ?? '').toString())
              .where((s) => s.isNotEmpty)
              .toList();
          if (mounted) setState(() => _scopeNames = list);
        }
      }
    } catch (e) {
      debugPrint('Error fetching scope groups: $e');
    }
  }

  Future<void> _fetchReferenceData() async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/reference-data'),
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map) {
          final zones = (data['zones'] as List?)?.whereType<String>().toList() ?? [];
          final divisionsRaw = data['divisionsByZone'];
          if (zones.isNotEmpty && mounted) {
            setState(() {
              _zones = zones;
              if (divisionsRaw is Map) {
                _divisionsByZone = divisionsRaw.map(
                  (k, v) => MapEntry(k.toString(), (v as List).whereType<String>().toList()),
                );
              }
            });
          }
        }
      }
    } catch (e) {
      debugPrint('Error fetching zone/division reference data: $e');
    }
  }

  Future<void> _fetchGates({bool isManualRefresh = false, String? overrideScopeId}) async {
    if (!isManualRefresh) {
      setState(() {
        _isLoading = true;
        _errorMessage = null;
      });
    }
    try {
      final activeScope = overrideScopeId ?? _developerScopeId;
      final query = activeScope.isNotEmpty ? '?scopeGroupId=${Uri.encodeComponent(activeScope)}' : '';

      final res = await http.get(
        Uri.parse('$baseUrl/lcgate$query'),
        headers: {'Authorization': 'Bearer $_token'},
      ).timeout(const Duration(seconds: 12));

      if (res.statusCode == 200) {
        final List raw = json.decode(res.body);
        // Deduplicate gates by ID to prevent duplicate cards in UI
        final seenIds = <int>{};
        final uniqueGates = <dynamic>[];
        for (final g in raw) {
          final id = g['id'] as int?;
          if (id != null && seenIds.add(id)) {
            uniqueGates.add(g);
          }
        }

        if (mounted) {
          setState(() {
            _gates = uniqueGates;
            _errorMessage = null;
          });
          if (isManualRefresh) {
            AppFeedback.showSuccess(context, 'LC Gates and clusters refreshed.');
          }
        }
      } else if (res.statusCode == 401) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.remove('token');
        await prefs.remove('user');
        if (!mounted) return;
        AppFeedback.showWarning(context, 'Your session has expired. Please log in again.');
        Navigator.of(context).pushAndRemoveUntil(
          MaterialPageRoute(builder: (_) => const AuthWrapper()),
          (route) => false,
        );
      } else {
        String msg = 'Failed to load clusters (HTTP ${res.statusCode}).';
        if (res.statusCode >= 500) {
          msg = 'Server temporarily unavailable (HTTP ${res.statusCode}). Please retry.';
        }
        if (mounted) {
          setState(() => _errorMessage = msg);
          if (_gates.isNotEmpty) AppFeedback.showError(context, msg);
        }
      }
    } catch (e) {
      final errStr = e.toString().toLowerCase();
      String friendlyMsg = 'Network error loading clusters: ${e.toString().replaceAll("Exception: ", "")}';
      if (errStr.contains('connection abort') || errStr.contains('clientexception') || errStr.contains('socketexception')) {
        friendlyMsg = 'Network connection interrupted. Please check your internet connection and tap Retry.';
      } else if (errStr.contains('timeoutexception')) {
        friendlyMsg = 'Connection timed out while contacting server. Please tap Retry.';
      }

      if (mounted) {
        setState(() => _errorMessage = friendlyMsg);
        if (_gates.isNotEmpty) {
          AppFeedback.showError(context, friendlyMsg);
        }
      }
    } finally {
      if (mounted && !isManualRefresh) setState(() => _isLoading = false);
    }
  }

  bool get _hasActiveFilters =>
      _filterZone.isNotEmpty ||
      _filterDivision.isNotEmpty ||
      _filterLocation.isNotEmpty ||
      _filterName.isNotEmpty ||
      _filterLc.isNotEmpty ||
      _sortBy != 'newest';

  int get _activeFilterCount {
    int count = 0;
    if (_filterZone.isNotEmpty) count++;
    if (_filterDivision.isNotEmpty) count++;
    if (_filterLocation.isNotEmpty) count++;
    if (_filterName.isNotEmpty) count++;
    if (_filterLc.isNotEmpty) count++;
    if (_sortBy != 'newest') count++;
    return count;
  }

  List<dynamic> get _visibleGates {
    final filtered = _gates.where((g) {
      final zone = (g['zone'] as String?) ?? '';
      final division = (g['division'] as String?) ?? '';
      final location = (g['locationName'] as String?) ?? '';
      final name = (g['name'] as String?) ?? '';
      final lc = (g['lcNumber'] as String?) ?? '';

      bool matches(String val, String filter) =>
          filter.isEmpty || val.toLowerCase().contains(filter.toLowerCase());

      if (_filterZone.isNotEmpty && zone.toLowerCase() != _filterZone.toLowerCase()) return false;
      if (_filterDivision.isNotEmpty && division.toLowerCase() != _filterDivision.toLowerCase()) return false;
      if (!matches(location, _filterLocation)) return false;
      if (!matches(name, _filterName)) return false;
      if (!matches(lc, _filterLc)) return false;
      return true;
    }).toList();

    filtered.sort((a, b) {
      switch (_sortBy) {
        case 'name_asc':
          return ((a['name'] as String?) ?? '').compareTo((b['name'] as String?) ?? '');
        case 'name_desc':
          return ((b['name'] as String?) ?? '').compareTo((a['name'] as String?) ?? '');
        case 'lc_asc':
          return ((a['lcNumber'] as String?) ?? '').compareTo((b['lcNumber'] as String?) ?? '');
        case 'zone_asc':
          return ((a['zone'] as String?) ?? '').compareTo((b['zone'] as String?) ?? '');
        case 'location_asc':
          return ((a['locationName'] as String?) ?? '').compareTo((b['locationName'] as String?) ?? '');
        case 'newest':
        default:
          final dateA = DateTime.tryParse((a['createdAt'] as String?) ?? '') ?? DateTime(0);
          final dateB = DateTime.tryParse((b['createdAt'] as String?) ?? '') ?? DateTime(0);
          return dateB.compareTo(dateA);
      }
    });
    return filtered;
  }

  void _resetFilters() {
    setState(() {
      _filterZone = '';
      _filterDivision = '';
      _filterLocation = '';
      _filterName = '';
      _filterLc = '';
      _sortBy = 'newest';
    });
    if (mounted) {
      AppFeedback.showInfo(context, 'Filter criteria reset.');
    }
  }

  void _openFilterSheet() {
    String zone = _filterZone;
    String division = _filterDivision;
    String sort = _sortBy;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheetState) {
          final divisions = zone.isNotEmpty ? (_divisionsByZone[zone] ?? <String>[]) : <String>[];
          final locCtrl = TextEditingController(text: _filterLocation);
          final nameCtrl = TextEditingController(text: _filterName);
          final lcCtrl = TextEditingController(text: _filterLc);
          final bottomInset = MediaQuery.of(sheetContext).viewInsets.bottom;
          final bottomPadding = MediaQuery.of(sheetContext).padding.bottom;

          return SafeArea(
            top: false,
            child: Padding(
              padding: EdgeInsets.only(
                left: 20,
                right: 20,
                top: 14,
                bottom: bottomInset > 0 ? bottomInset + 16 : (bottomPadding > 0 ? bottomPadding + 16 : 24),
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Center(
                      child: Container(
                        width: 40,
                        height: 4,
                        margin: const EdgeInsets.only(bottom: 12),
                        decoration: BoxDecoration(
                          color: Colors.grey.shade300,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('Filter & Sort', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                        TextButton(
                          onPressed: () {
                            setSheetState(() {
                              zone = '';
                              division = '';
                              sort = 'newest';
                              locCtrl.clear();
                              nameCtrl.clear();
                              lcCtrl.clear();
                            });
                            AppFeedback.showInfo(context, 'Filter selections reset.');
                          },
                          child: const Text('Reset'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    DropdownButtonFormField<String>(
                      initialValue: zone.isEmpty ? null : zone,
                      decoration: const InputDecoration(labelText: 'Zone'),
                      items: _zones
                          .map((z) => DropdownMenuItem(value: z, child: Text(z, overflow: TextOverflow.ellipsis)))
                          .toList(),
                      onChanged: (val) => setSheetState(() {
                        zone = val ?? '';
                        division = '';
                      }),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: division.isEmpty ? null : division,
                      decoration: const InputDecoration(labelText: 'Division'),
                      items: divisions
                          .map((d) => DropdownMenuItem(value: d, child: Text(d, overflow: TextOverflow.ellipsis)))
                          .toList(),
                      onChanged: zone.isEmpty ? null : (val) => setSheetState(() => division = val ?? ''),
                      hint: Text(zone.isEmpty ? 'Select Zone first…' : 'Select Division…'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: locCtrl,
                      decoration: const InputDecoration(labelText: 'Location', prefixIcon: Icon(Icons.location_city)),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: nameCtrl,
                      decoration: const InputDecoration(labelText: 'Gate Name', prefixIcon: Icon(Icons.label)),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: lcCtrl,
                      decoration: const InputDecoration(labelText: 'LC Number', prefixIcon: Icon(Icons.numbers), hintText: 'e.g. LC-0001'),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: sort,
                      decoration: const InputDecoration(labelText: 'Sort By'),
                      items: _sortOptions
                          .map((o) => DropdownMenuItem(value: o['value'], child: Text(o['label']!)))
                          .toList(),
                      onChanged: (val) => setSheetState(() => sort = val ?? 'newest'),
                    ),
                    const SizedBox(height: 24),
                    ElevatedButton(
                      onPressed: () {
                        setState(() {
                          _filterZone = zone;
                          _filterDivision = division;
                          _filterLocation = locCtrl.text;
                          _filterName = nameCtrl.text;
                          _filterLc = lcCtrl.text;
                          _sortBy = sort;
                        });
                        Navigator.pop(sheetContext);
                        final count = _visibleGates.length;
                        if (count > 0) {
                          AppFeedback.showSuccess(
                            context,
                            'Filters applied: $count LC ${count == 1 ? "Gate" : "Gates"} found.',
                          );
                        } else {
                          AppFeedback.showInfo(context, 'Filters applied: No matching LC Gates found.');
                        }
                      },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                      ),
                      child: const Text('Apply Filters', style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Colors.white)),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  Future<void> _deleteGate(Map gate) async {
    final ctrl = TextEditingController();
    final targetName = (gate['name'] ?? gate['lcNumber'] ?? 'Gate').toString();
    bool confirm = await showDialog(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: const Text('Are you absolutely sure?', style: TextStyle(color: Colors.red)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('This action cannot be undone. It will permanently delete this LC Gate and all associated Master units, Slave devices, and photographic evidence.'),
            const SizedBox(height: 16),
            Text('Please type "$targetName" to confirm:'),
            const SizedBox(height: 8),
            TextField(
              controller: ctrl,
              decoration: const InputDecoration(border: OutlineInputBorder()),
            )
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogCtx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () {
              if (ctrl.text.trim() == targetName) {
                Navigator.pop(dialogCtx, true);
              } else {
                AppFeedback.showWarning(context, 'Entered name does not match "$targetName". Deletion aborted.');
              }
            }, 
            child: const Text('Delete this gate', style: TextStyle(color: Colors.white))
          ),
        ],
      )
    ) ?? false;

    if (!confirm) return;

    setState(() => _isLoading = true);
    try {
      final res = await http.delete(
        Uri.parse('$baseUrl/lcgate/${gate['id']}'),
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (res.statusCode == 204 || res.statusCode == 200) {
        LCGatesCacheService.instance.removeGate(_userId, gate['id']);
        await _fetchGates();
        if (mounted) {
          AppFeedback.showSuccess(context, 'LC Gate "$targetName" permanently deleted.');
        }
      } else {
        String errMsg = 'Failed to delete LC Gate';
        try {
          final err = json.decode(res.body);
          if (err['error'] != null) errMsg = err['error'];
        } catch (_) {}
        if (mounted) {
          AppFeedback.showError(context, errMsg);
          setState(() => _isLoading = false);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error deleting LC Gate: $e');
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _visibleGates;

    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      appBar: AppBar(
        title: const Text('LC Gate Clusters', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        elevation: 1,
        backgroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: AppColors.primary),
            tooltip: 'Refresh Gates',
            onPressed: () => _fetchGates(isManualRefresh: true),
          ),
          IconButton(
            icon: Badge(
              isLabelVisible: _hasActiveFilters,
              label: Text('$_activeFilterCount'),
              child: const Icon(Icons.filter_list, color: AppColors.primary),
            ),
            tooltip: 'Filter & Sort',
            onPressed: _openFilterSheet,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text('Create Gate'),
        onPressed: () async {
          final result = await Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => CreateGateScreen(token: _token),
            ),
          );
          if (!mounted) return;
          if (result == true) {
            LCGatesCacheService.instance.markStale(_userId);
            _fetchGates();
            if (mounted) {
              AppFeedback.showSuccess(context, 'New LC Gate created and added to cluster list.');
            }
          }
        },
      ),
      body: Column(
        children: [
          // 1. Developer Scope View Selector Strip (Parity with Web ClusterDashboard)
          if (_isDeveloper && _allScopeGroupsList.isNotEmpty)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              color: Colors.white,
              child: Row(
                children: [
                  const Icon(Icons.layers_outlined, size: 18, color: AppColors.primary),
                  const SizedBox(width: 8),
                  const Text('Scope View:', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFF334155))),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF8FAFC),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFCBD5E1)),
                      ),
                      child: DropdownButtonHideUnderline(
                        child: DropdownButton<String>(
                          value: _developerScopeId,
                          isExpanded: true,
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary),
                          items: [
                            const DropdownMenuItem(value: '', child: Text('My Assigned Scope')),
                            const DropdownMenuItem(value: 'all', child: Text('All Gates (Admin View)')),
                            ..._allScopeGroupsList.map((sg) {
                              final idStr = sg['id'].toString();
                              final name = sg['name'] ?? 'Scope';
                              final count = sg['_count']?['gates'] ?? sg['gates']?.length ?? 0;
                              return DropdownMenuItem(
                                value: idStr,
                                child: Text('$name ($count gates)', overflow: TextOverflow.ellipsis),
                              );
                            }),
                          ],
                          onChanged: (val) {
                            if (val != null) {
                              setState(() => _developerScopeId = val);
                              _fetchGates(overrideScopeId: val);
                              final msg = val == 'all'
                                  ? 'Switched to All Gates (Admin View).'
                                  : val.isNotEmpty
                                      ? 'Filtered gates by selected scope group.'
                                      : 'Switched to Assigned Scope.';
                              AppFeedback.showInfo(context, msg);
                            }
                          },
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),

          // 2. Assigned Scope Banner (when not in "All")
          if (_scopeNames.isNotEmpty && _developerScopeId != 'all')
            Container(
              margin: const EdgeInsets.fromLTRB(14, 8, 14, 0),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.05),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.primary.withValues(alpha: 0.15)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.layers, size: 16, color: AppColors.primary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Assigned Scope: ${_scopeNames.join(", ")}',
                      style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: Color(0xFF0F172A)),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: AppColors.primary,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      '${filtered.length} Accessible',
                      style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                  ),
                ],
              ),
            ),

          // 3. Active Filters Chips Strip (Visible when filters are active)
          if (_hasActiveFilters)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              alignment: Alignment.centerLeft,
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    const Text('Active:', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
                    const SizedBox(width: 6),
                    if (_filterZone.isNotEmpty)
                      _buildFilterChip('Zone: $_filterZone', () => setState(() {
                        _filterZone = '';
                        _filterDivision = '';
                      })),
                    if (_filterDivision.isNotEmpty)
                      _buildFilterChip('Div: $_filterDivision', () => setState(() => _filterDivision = '')),
                    if (_filterLocation.isNotEmpty)
                      _buildFilterChip('Loc: $_filterLocation', () => setState(() => _filterLocation = '')),
                    if (_filterName.isNotEmpty)
                      _buildFilterChip('Gate: $_filterName', () => setState(() => _filterName = '')),
                    if (_filterLc.isNotEmpty)
                      _buildFilterChip('LC: $_filterLc', () => setState(() => _filterLc = '')),
                    if (_sortBy != 'newest')
                      _buildFilterChip('Sort: $_sortBy', () => setState(() => _sortBy = 'newest')),
                    TextButton(
                      style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                      onPressed: _resetFilters,
                      child: const Text('Clear All', style: TextStyle(fontSize: 11, color: Colors.red)),
                    ),
                  ],
                ),
              ),
            ),

          // 4. Gates List View (Network Error Handling, Cache Preservation & Clean Hierarchy)
          Expanded(
            child: _isLoading && _gates.isEmpty
                ? const Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        CircularProgressIndicator(),
                        SizedBox(height: 14),
                        Text('Loading LC Gate Clusters...', style: TextStyle(color: Colors.grey, fontSize: 13)),
                      ],
                    ),
                  )
                : _errorMessage != null && _gates.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 32),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.cloud_off_rounded, size: 54, color: Colors.red.shade400),
                              const SizedBox(height: 14),
                              const Text(
                                'Unable to Load Clusters',
                                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17, color: Color(0xFF1E293B)),
                                textAlign: TextAlign.center,
                              ),
                              const SizedBox(height: 8),
                              Text(
                                _errorMessage!,
                                style: TextStyle(color: Colors.grey.shade600, fontSize: 13, height: 1.4),
                                textAlign: TextAlign.center,
                              ),
                              const SizedBox(height: 20),
                              ElevatedButton.icon(
                                onPressed: () => _fetchGates(),
                                icon: const Icon(Icons.refresh, size: 18),
                                label: const Text('Retry Connection'),
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: AppColors.primary,
                                  foregroundColor: Colors.white,
                                  padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 12),
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                ),
                              ),
                            ],
                          ),
                        ),
                      )
                    : _gates.isEmpty
                        ? Center(
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 32),
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Icon(Icons.shield_outlined, size: 52, color: Colors.grey.shade400),
                                  const SizedBox(height: 14),
                                  const Text(
                                    'No Gates in Your Assigned Scope',
                                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFF1E293B)),
                                    textAlign: TextAlign.center,
                                  ),
                                  const SizedBox(height: 6),
                                  Text(
                                    'You have not been assigned to any Scope Groups containing LC Gates yet. Contact your system administrator.',
                                    style: TextStyle(color: Colors.grey.shade600, fontSize: 12.5, height: 1.4),
                                    textAlign: TextAlign.center,
                                  ),
                                ],
                              ),
                            ),
                          )
                        : filtered.isEmpty
                            ? Center(
                                child: Column(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    const Icon(Icons.search_off, size: 48, color: Colors.grey),
                                    const SizedBox(height: 12),
                                    const Text('No gates match the current filters.', style: TextStyle(color: Colors.grey, fontSize: 15)),
                                    const SizedBox(height: 12),
                                    OutlinedButton(onPressed: _resetFilters, child: const Text('Clear Filters')),
                                  ],
                                ),
                              )
                            : RefreshIndicator(
                                onRefresh: () => _fetchGates(isManualRefresh: true),
                                child: ListView.builder(
                                  physics: const AlwaysScrollableScrollPhysics(),
                                  padding: const EdgeInsets.fromLTRB(14, 10, 14, 80),
                                  itemCount: filtered.length + (_errorMessage != null ? 1 : 0),
                                  itemBuilder: (context, index) {
                                    // If there's an error banner while displaying cached data
                                    if (_errorMessage != null && index == 0) {
                                      return Container(
                                        margin: const EdgeInsets.only(bottom: 12),
                                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                                        decoration: BoxDecoration(
                                          color: const Color(0xFFFEF2F2),
                                          borderRadius: BorderRadius.circular(10),
                                          border: Border.all(color: const Color(0xFFFCA5A5)),
                                        ),
                                        child: Row(
                                          children: [
                                            const Icon(Icons.wifi_off_rounded, color: Color(0xFFDC2626), size: 20),
                                            const SizedBox(width: 10),
                                            Expanded(
                                              child: Text(
                                                _errorMessage!,
                                                style: const TextStyle(fontSize: 12, color: Color(0xFF991B1B)),
                                              ),
                                            ),
                                            const SizedBox(width: 8),
                                            TextButton(
                                              style: TextButton.styleFrom(
                                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                                minimumSize: Size.zero,
                                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                              ),
                                              onPressed: () => _fetchGates(isManualRefresh: true),
                                              child: const Text('Retry', style: TextStyle(fontWeight: FontWeight.bold, color: Color(0xFFDC2626))),
                                            ),
                                          ],
                                        ),
                                      );
                                    }

                                    final gateIndex = _errorMessage != null ? index - 1 : index;
                                    final gate = filtered[gateIndex];
                                    final masters = gate['masters'] as List? ?? [];
                                    final zone = (gate['zone'] as String?) ?? '';
                                    final division = (gate['division'] as String?) ?? '';
                                    final locName = (gate['locationName'] ?? 'Unnamed Location').toString();
                                    final lcNumber = (gate['lcNumber'] ?? 'LC-GATE').toString();
                                    final customName = (gate['name'] != null && (gate['name'] as String).isNotEmpty && gate['name'] != lcNumber)
                                        ? gate['name'] as String
                                        : null;

                                    return Card(
                                      elevation: 1,
                                      margin: const EdgeInsets.only(bottom: 12),
                                      shape: RoundedRectangleBorder(
                                        borderRadius: BorderRadius.circular(12),
                                        side: const BorderSide(color: Color(0xFFE2E8F0)),
                                      ),
                                      child: InkWell(
                                        borderRadius: BorderRadius.circular(12),
                                        onTap: () async {
                                          final result = await Navigator.push(
                                            context,
                                            MaterialPageRoute(
                                              builder: (_) => GateDetailScreen(token: _token, gate: gate),
                                            ),
                                          );
                                          if (!mounted) return;
                                          if (result == true) {
                                            _fetchGates();
                                            if (mounted) {
                                              AppFeedback.showSuccess(context, 'LC Gate details refreshed.');
                                            }
                                          }
                                        },
                                        child: Padding(
                                          padding: const EdgeInsets.all(14),
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: [
                                              // Header row: Unique LC Number heading (no repeated badge) + Status + Zone + Delete
                                              Row(
                                                crossAxisAlignment: CrossAxisAlignment.start,
                                                children: [
                                                  Expanded(
                                                    child: Column(
                                                      crossAxisAlignment: CrossAxisAlignment.start,
                                                      children: [
                                                        Text(
                                                          lcNumber,
                                                          style: const TextStyle(
                                                            fontSize: 16,
                                                            fontWeight: FontWeight.bold,
                                                            color: Color(0xFF0F172A),
                                                          ),
                                                        ),
                                                        if (customName != null) ...[
                                                          const SizedBox(height: 2),
                                                          Text(
                                                            customName,
                                                            style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                                                            maxLines: 1,
                                                            overflow: TextOverflow.ellipsis,
                                                          ),
                                                        ],
                                                        const SizedBox(height: 6),
                                                        Row(
                                                          children: [
                                                            Builder(
                                                              builder: (context) {
                                                                final isOnline = gate['deviceStatus'] == 'ONLINE' || gate['isOnline'] == true;
                                                                return Container(
                                                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                                                  decoration: BoxDecoration(
                                                                    color: isOnline ? const Color(0xFFECFDF5) : const Color(0xFFFEF2F2),
                                                                    borderRadius: BorderRadius.circular(4),
                                                                    border: Border.all(color: isOnline ? const Color(0xFFA7F3D0) : const Color(0xFFFECACA)),
                                                                  ),
                                                                  child: Row(
                                                                    mainAxisSize: MainAxisSize.min,
                                                                    children: [
                                                                      Container(
                                                                        width: 5,
                                                                        height: 5,
                                                                        decoration: BoxDecoration(
                                                                          shape: BoxShape.circle,
                                                                          color: isOnline ? const Color(0xFF10B981) : const Color(0xFFEF4444),
                                                                        ),
                                                                      ),
                                                                      const SizedBox(width: 4),
                                                                      Text(
                                                                        isOnline ? 'ONLINE' : 'OFFLINE',
                                                                        style: TextStyle(
                                                                          fontSize: 9.5,
                                                                          fontWeight: FontWeight.bold,
                                                                          color: isOnline ? const Color(0xFF047857) : const Color(0xFFB91C1C),
                                                                        ),
                                                                      ),
                                                                    ],
                                                                  ),
                                                                );
                                                              },
                                                            ),
                                                            if (zone.isNotEmpty) ...[
                                                              const SizedBox(width: 6),
                                                              Container(
                                                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                                                decoration: BoxDecoration(
                                                                  color: const Color(0xFFEEF2FF),
                                                                  borderRadius: BorderRadius.circular(4),
                                                                ),
                                                                child: Text(
                                                                  zone,
                                                                  style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF4338CA)),
                                                                ),
                                                              ),
                                                            ],
                                                            if (division.isNotEmpty) ...[
                                                              const SizedBox(width: 6),
                                                              Container(
                                                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                                                decoration: BoxDecoration(
                                                                  color: const Color(0xFFECFEFF),
                                                                  borderRadius: BorderRadius.circular(4),
                                                                ),
                                                                child: Text(
                                                                  division,
                                                                  style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF0E9AA7)),
                                                                ),
                                                              ),
                                                            ],
                                                          ],
                                                        ),
                                                      ],
                                                    ),
                                                  ),
                                                  IconButton(
                                                    visualDensity: VisualDensity.compact,
                                                    icon: const Icon(Icons.delete_outline, color: Colors.red, size: 20),
                                                    tooltip: 'Delete Gate',
                                                    onPressed: () => _deleteGate(gate),
                                                  ),
                                                ],
                                              ),
                                              const SizedBox(height: 12),

                                              // Location Description Row
                                              Row(
                                                children: [
                                                  Container(
                                                    padding: const EdgeInsets.all(6),
                                                    decoration: BoxDecoration(
                                                      color: const Color(0xFF0E9AA7).withValues(alpha: 0.1),
                                                      borderRadius: BorderRadius.circular(8),
                                                    ),
                                                    child: const Icon(Icons.location_on_outlined, size: 16, color: Color(0xFF0E9AA7)),
                                                  ),
                                                  const SizedBox(width: 8),
                                                  Expanded(
                                                    child: Text(
                                                      locName,
                                                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: Color(0xFF334155)),
                                                      overflow: TextOverflow.ellipsis,
                                                    ),
                                                  ),
                                                ],
                                              ),
                                              const SizedBox(height: 6),

                                              // Master Units Count Row
                                              Row(
                                                children: [
                                                  Container(
                                                    padding: const EdgeInsets.all(6),
                                                    decoration: BoxDecoration(
                                                      color: AppColors.primary.withValues(alpha: 0.08),
                                                      borderRadius: BorderRadius.circular(8),
                                                    ),
                                                    child: const Icon(Icons.computer_outlined, size: 16, color: AppColors.primary),
                                                  ),
                                                  const SizedBox(width: 8),
                                                  Text(
                                                    '${masters.length} Master Unit${masters.length == 1 ? "" : "s"} Registered',
                                                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: Color(0xFF334155)),
                                                  ),
                                                ],
                                              ),
                                              const SizedBox(height: 10),
                                              const Divider(height: 1, color: Color(0xFFF1F5F9)),
                                              const SizedBox(height: 8),

                                              // Bottom Row: Asset status & Device Info Action (Removed redundant duplicate ID)
                                              Row(
                                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                                children: [
                                                  Text(
                                                    masters.isEmpty ? 'No Master Hardware' : (masters.first['powerSource'] == 'SOLAR' ? 'Solar Powered' : 'Direct Powered'),
                                                    style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                                                  ),
                                                  if (masters.isNotEmpty)
                                                    OutlinedButton.icon(
                                                      style: OutlinedButton.styleFrom(
                                                        visualDensity: VisualDensity.compact,
                                                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                                        side: const BorderSide(color: Color(0xFFCBD5E1)),
                                                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                                      ),
                                                      icon: const Icon(Icons.developer_board, size: 14, color: AppColors.primary),
                                                      label: const Text('Device Info', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.primary)),
                                                      onPressed: () => DeviceInfoSheet.show(context, gate: Map<String, dynamic>.from(gate)),
                                                    ),
                                                ],
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    );
                                  },
                                ),
                              ),
          )        ],
      ),
    );
  }

  Widget _buildFilterChip(String label, VoidCallback onRemove) {
    return Container(
      margin: const EdgeInsets.only(right: 6),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: const Color(0xFFEFF6FF),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFBFDBFE)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Color(0xFF1E40AF))),
          const SizedBox(width: 4),
          InkWell(
            onTap: onRemove,
            child: const Icon(Icons.close, size: 12, color: Color(0xFF1E40AF)),
          ),
        ],
      ),
    );
  }
}
