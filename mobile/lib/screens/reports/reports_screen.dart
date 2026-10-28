import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:path_provider/path_provider.dart';
import 'package:open_filex/open_filex.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';

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

class _ReportsScreenState extends State<ReportsScreen> {
  String _token = '';
  bool _isDeveloper = false;

  // 1. Clusters & Hierarchy Selection
  List<dynamic> _clusters = [];
  bool _isLoadingClusters = true;
  final Set<int> _selectedClusterIds = {};
  final Set<int> _selectedGateIds = {};

  // 2. Date Range (Default: Last 7 Days)
  late DateTimeRange _dateRange;
  String _activePreset = '7days';

  // 3. Operational Records & Metrics
  List<dynamic> _records = [];
  Map<String, dynamic> _metrics = {
    'totalOperations': 0,
    'totalDurationFormatted': '0s',
    'avgDurationFormatted': '0s',
    'extendedDelaysCount': 0,
    'currentlyOpenCount': 0,
    'reportingGatesCount': 0,
  };
  bool _isLoadingRecords = true;

  // 4. Filters & Sorting
  String _filterStatus = 'ALL';
  String _filterShift = 'ALL';
  String _sortBy = 'openedAt';
  String _sortOrder = 'desc';
  final TextEditingController _searchCtrl = TextEditingController();
  String _searchQuery = '';

  // 5. Generate Report Export State
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
    _isDeveloper = widget.user['role'] == 'Developer';
    final now = DateTime.now();
    _dateRange = DateTimeRange(
      start: now.subtract(const Duration(days: 7)),
      end: now,
    );
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
    await _fetchClusters();
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $_token',
      };

  String _formatDate(DateTime d) {
    final y = d.year.toString().padLeft(4, '0');
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
    _fetchRecords();
  }

  // 1. Fetch Clusters Tree
  Future<void> _fetchClusters() async {
    setState(() => _isLoadingClusters = true);
    try {
      final res = await http.get(Uri.parse('$baseUrl/reports/clusters'), headers: _headers);
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final list = (data['clusters'] as List?) ?? [];
        if (mounted) {
          setState(() {
            _clusters = list;
            // Select all by default
            _selectedClusterIds.clear();
            _selectedGateIds.clear();
            for (final c in list) {
              if (c['id'] != null) _selectedClusterIds.add(c['id'] as int);
              final gates = (c['gates'] as List?) ?? [];
              for (final g in gates) {
                if (g['id'] != null) _selectedGateIds.add(g['id'] as int);
              }
            }
          });
          _fetchRecords();
        }
      } else if (res.statusCode == 403 && mounted) {
        AppFeedback.showError(context, 'No clusters are assigned to your user account.');
      }
    } catch (_) {
    } finally {
      if (mounted) setState(() => _isLoadingClusters = false);
    }
  }

  // 2. Fetch Operational Records
  Future<void> _fetchRecords() async {
    if (_selectedGateIds.isEmpty) {
      if (mounted) setState(() { _records = []; _isLoadingRecords = false; });
      return;
    }
    setState(() => _isLoadingRecords = true);
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
      final res = await http.get(uri, headers: _headers);

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _records = (data['records'] as List?) ?? [];
            _metrics = (data['metrics'] as Map<String, dynamic>?) ?? _metrics;
          });
        }
      }
    } catch (_) {
    } finally {
      if (mounted) setState(() => _isLoadingRecords = false);
    }
  }

  // 3. Hierarchy Tree Bottom Sheet
  void _showHierarchyTreeSheet() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            return Container(
              height: MediaQuery.of(context).size.height * 0.78,
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
              ),
              child: Column(
                children: [
                  // Handle & Header
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
                  // Scrollable Clusters and Gates Tree
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
                              Container(width: 8, height: 8, decoration: BoxDecoration(color: cColor, shape: BoxShape.circle)),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(cluster['name'] ?? 'Cluster', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                              ),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(color: Colors.grey.shade100, borderRadius: BorderRadius.circular(10)),
                                child: Text('${gates.length}', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.grey)),
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
                  // Bottom Button to Apply
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
                            _fetchRecords();
                          },
                          child: Text('Apply Selection (${_selectedGateIds.length} Gates)', style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
                        ),
                      ),
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

  // 4. Generate Report Modal (Excel & PDF)
  void _showGenerateModal() {
    String selectedFormat = 'xlsx';
    final Set<String> selectedCols = _reportColumns.map((c) => c['key']!).toSet();

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setModalState) {
            return Container(
              height: MediaQuery.of(context).size.height * 0.82,
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
              ),
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
                        // Filter Summary Card
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
                              Text('Events in range: ${_records.length}', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                        const Text('SELECT DOCUMENT FORMAT', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.grey)),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            // Excel Card
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
                            // PDF Card
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
                              : () async {
                                  if (_selectedGateIds.isEmpty) {
                                    AppFeedback.showInfo(context, 'Please select at least one gate to export.');
                                    return;
                                  }
                                  Navigator.pop(ctx);
                                  setState(() => _isExporting = true);
                                  try {
                                    final queryParams = <String, String>{
                                      'startDate': _formatDate(_dateRange.start),
                                      'endDate': _formatDate(_dateRange.end),
                                      'format': selectedFormat,
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

                                    if (res.statusCode == 200) {
                                      try {
                                        final dir = await getApplicationDocumentsDirectory();
                                        final ext = selectedFormat == 'pdf' ? 'pdf' : 'xlsx';
                                        final timestamp = DateTime.now().millisecondsSinceEpoch;
                                        final file = File('${dir.path}/LC_Gate_Report_$timestamp.$ext');
                                        await file.writeAsBytes(res.bodyBytes, flush: true);

                                        if (mounted) {
                                          AppFeedback.showSuccess(context, 'Report saved (${(res.bodyBytes.length / 1024).toStringAsFixed(1)} KB)! Opening...');
                                          final openResult = await OpenFilex.open(file.path);
                                          if (openResult.type != ResultType.done && mounted) {
                                            AppFeedback.showInfo(context, 'Saved to ${file.path}');
                                          }
                                        }
                                      } catch (fileErr) {
                                        if (mounted) {
                                          AppFeedback.showWarning(context, 'Report downloaded, but could not open viewer: $fileErr');
                                        }
                                      }
                                    } else {
                                      if (mounted) AppFeedback.showError(context, 'Export failed: HTTP ${res.statusCode}');
                                    }
                                  } catch (e) {
                                    if (mounted) AppFeedback.showError(context, 'Export error: $e');
                                  } finally {
                                    if (mounted) setState(() => _isExporting = false);
                                  }
                                },
                        ),
                      ),
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
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
            onPressed: _fetchRecords,
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
              onRefresh: _fetchRecords,
              child: ListView(
                padding: const EdgeInsets.all(12),
                children: [
                  // 1. Scope Groups & Gates Tree Trigger Card
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

                  // 2. Date Range Picker Card & Presets
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
                                  _fetchRecords();
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
                        // Presets Row
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

                  // 3. Search and Status Filters
                  Row(
                    children: [
                      Expanded(
                        child: Container(
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
                      ),
                      const SizedBox(width: 8),
                      // Status Filter Dropdown
                      Container(
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
                    ],
                  ),
                  const SizedBox(height: 12),

                  // 5. Operational Records Logsheet
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('Logsheet Records (${_records.length})', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                      TextButton.icon(
                        icon: const Icon(Icons.tune, size: 15),
                        label: const Text('Sort Order', style: TextStyle(fontSize: 12)),
                        onPressed: () {
                          setState(() {
                            _sortOrder = _sortOrder == 'asc' ? 'desc' : 'asc';
                          });
                          _fetchRecords();
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),

                  if (_isLoadingRecords)
                    const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))
                  else if (_records.isEmpty)
                    Container(
                      padding: const EdgeInsets.all(32),
                      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
                      child: Column(
                        children: [
                          Icon(Icons.meeting_room_outlined, size: 40, color: Colors.grey.shade400),
                          const SizedBox(height: 8),
                          const Text('No operational records found', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.grey)),
                          const SizedBox(height: 4),
                          const Text('Try selecting more clusters/gates or widening the date range.', style: TextStyle(fontSize: 11.5, color: Colors.grey), textAlign: TextAlign.center),
                        ],
                      ),
                    )
                  else
                    ..._records.map((rec) => _buildRecordCard(rec)),
                ],
              ),
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
}
