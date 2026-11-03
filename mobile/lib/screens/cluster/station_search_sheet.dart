import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import 'railway_data.dart';

class StationSearchSheet extends StatefulWidget {
  final String token;
  final String? zone;
  final String? division;
  final String? selectedCode;
  final ValueChanged<StationReference> onSelected;

  const StationSearchSheet({
    super.key,
    required this.token,
    required this.zone,
    required this.division,
    this.selectedCode,
    required this.onSelected,
  });

  static Future<StationReference?> show(
    BuildContext context, {
    required String token,
    required String? zone,
    required String? division,
    String? selectedCode,
  }) async {
    return showModalBottomSheet<StationReference>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => FractionallySizedBox(
        heightFactor: 0.85,
        child: StationSearchSheet(
          token: token,
          zone: zone,
          division: division,
          selectedCode: selectedCode,
          onSelected: (st) => Navigator.pop(ctx, st),
        ),
      ),
    );
  }

  @override
  State<StationSearchSheet> createState() => _StationSearchSheetState();
}

class _StationSearchSheetState extends State<StationSearchSheet> {
  final TextEditingController _searchCtrl = TextEditingController();
  List<StationReference> _allStations = [];
  List<StationReference> _filteredStations = [];
  bool _isLoading = true;
  String _searchQuery = '';

  @override
  void initState() {
    super.initState();
    _loadStations();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadStations() async {
    setState(() => _isLoading = true);

    // Initial load from local authentic data
    final localList = RailwayData.stationsForDivision(widget.division);
    _allStations = List.from(localList);
    _filterStations();

    try {
      final queryParams = <String>[];
      if (widget.division != null && widget.division!.isNotEmpty) {
        queryParams.add('division=${Uri.encodeComponent(widget.division!)}');
      }
      if (widget.zone != null && widget.zone!.isNotEmpty) {
        queryParams.add('zone=${Uri.encodeComponent(widget.zone!)}');
      }
      final qStr = queryParams.isNotEmpty ? '?${queryParams.join('&')}' : '';

      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/stations$qStr'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      ).timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        final List data = json.decode(res.body);
        final seen = <String>{};
        final merged = <StationReference>[];

        for (final item in data) {
          final code = (item['code'] ?? '').toString().toUpperCase().trim();
          final name = (item['name'] ?? '').toString().trim();
          if (code.isNotEmpty && seen.add(code)) {
            merged.add(StationReference(code: code, name: name));
          }
        }

        // Merge any local stations not in backend response
        for (final loc in localList) {
          if (seen.add(loc.code)) {
            merged.add(loc);
          }
        }

        if (mounted && merged.isNotEmpty) {
          setState(() {
            _allStations = merged;
            _isLoading = false;
          });
          _filterStations();
          return;
        }
      }
    } catch (e) {
      debugPrint('Error fetching stations from backend: $e');
    }

    if (mounted) {
      setState(() => _isLoading = false);
      _filterStations();
    }
  }

  void _filterStations() {
    final query = _searchQuery.toLowerCase().trim();
    if (query.isEmpty) {
      _filteredStations = List.from(_allStations);
    } else {
      _filteredStations = _allStations.where((s) {
        return s.name.toLowerCase().contains(query) || s.code.toLowerCase().contains(query);
      }).toList();
    }
  }

  Future<void> _showAddCustomStationDialog() async {
    final nameCtrl = TextEditingController();
    final codeCtrl = TextEditingController();
    bool isSaving = false;

    final result = await showDialog<StationReference>(
      context: context,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          title: const Row(
            children: [
              Icon(Icons.add_location_alt_outlined, color: AppColors.primary, size: 22),
              SizedBox(width: 8),
              Text('Add Custom Station', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            ],
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Add a new station under ${widget.division ?? 'current division'} (${widget.zone ?? 'Zone'}).',
                style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: nameCtrl,
                decoration: const InputDecoration(
                  labelText: 'Station Name *',
                  hintText: 'e.g. Kasu Junction',
                  isDense: true,
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: codeCtrl,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(
                  labelText: 'Station Code *',
                  hintText: 'e.g. KASU',
                  isDense: true,
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: isSaving ? null : () => Navigator.pop(dialogCtx),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: isSaving
                  ? null
                  : () async {
                      final n = nameCtrl.text.trim();
                      final c = codeCtrl.text.trim().toUpperCase();
                      if (n.isEmpty || c.isEmpty) {
                        AppFeedback.showWarning(context, 'Station name and code are required.');
                        return;
                      }

                      setDialogState(() => isSaving = true);
                      try {
                        final res = await http.post(
                          Uri.parse('$baseUrl/lcgate/stations'),
                          headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ${widget.token}',
                          },
                          body: json.encode({
                            'name': n,
                            'code': c,
                            'division': widget.division ?? '',
                            'zone': widget.zone ?? '',
                          }),
                        );

                        if (res.statusCode == 200 || res.statusCode == 201) {
                          final data = json.decode(res.body);
                          final created = StationReference(
                            code: data['code'] ?? c,
                            name: data['name'] ?? n,
                          );
                          if (dialogCtx.mounted) {
                            Navigator.pop(dialogCtx, created);
                          }
                          return;
                        } else {
                          final err = json.decode(res.body);
                          if (dialogCtx.mounted) {
                            AppFeedback.showError(context, err['error'] ?? 'Failed to add station.');
                          }
                        }
                      } catch (e) {
                        if (dialogCtx.mounted) {
                          AppFeedback.showError(context, 'Error creating station: $e');
                        }
                      } finally {
                        if (dialogCtx.mounted) setDialogState(() => isSaving = false);
                      }
                    },
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: Colors.white,
              ),
              child: isSaving
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Save & Select'),
            ),
          ],
        ),
      ),
    );

    if (result != null && mounted) {
      widget.onSelected(result);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: Column(
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
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Select Railway Station',
                      style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                    ),
                    Text(
                      '${widget.division ?? 'All Divisions'} • ${_filteredStations.length} stations found',
                      style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                    ),
                  ],
                ),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),

          // Search Bar
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: TextField(
              controller: _searchCtrl,
              autofocus: true,
              decoration: InputDecoration(
                hintText: 'Search by station name or code...',
                prefixIcon: const Icon(Icons.search, color: Color(0xFF64748B)),
                suffixIcon: _searchCtrl.text.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear, size: 18),
                        onPressed: () {
                          _searchCtrl.clear();
                          setState(() {
                            _searchQuery = '';
                            _filterStations();
                          });
                        },
                      )
                    : null,
                filled: true,
                fillColor: const Color(0xFFF1F5F9),
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide.none,
                ),
              ),
              onChanged: (val) {
                setState(() {
                  _searchQuery = val;
                  _filterStations();
                });
              },
            ),
          ),

          // Add Custom Station Action Bar
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: _showAddCustomStationDialog,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.06),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.primary.withValues(alpha: 0.2)),
                ),
                child: const Row(
                  children: [
                    Icon(Icons.add_circle_outline, size: 18, color: AppColors.primary),
                    SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '+ Add Custom Railway Station',
                        style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: AppColors.primary),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),

          const Divider(height: 14),

          // Stations List
          Expanded(
            child: _isLoading && _allStations.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : _filteredStations.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(Icons.search_off, size: 44, color: Colors.grey),
                            const SizedBox(height: 8),
                            Text('No station matching "$_searchQuery"', style: const TextStyle(color: Colors.grey)),
                            const SizedBox(height: 12),
                            OutlinedButton.icon(
                              onPressed: _showAddCustomStationDialog,
                              icon: const Icon(Icons.add, size: 16),
                              label: const Text('Add This Station'),
                            ),
                          ],
                        ),
                      )
                    : ListView.separated(
                        itemCount: _filteredStations.length,
                        separatorBuilder: (_, __) => const Divider(height: 1, indent: 16, endIndent: 16),
                        itemBuilder: (context, index) {
                          final st = _filteredStations[index];
                          final isSelected = widget.selectedCode != null &&
                              widget.selectedCode!.toUpperCase() == st.code.toUpperCase();

                          return ListTile(
                            dense: true,
                            contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 2),
                            title: Text(
                              st.name,
                              style: TextStyle(
                                fontWeight: isSelected ? FontWeight.bold : FontWeight.w500,
                                fontSize: 14,
                                color: isSelected ? AppColors.primary : const Color(0xFF0F172A),
                              ),
                            ),
                            subtitle: Text(
                              'Code: ${st.code}${widget.division != null ? ' • ${widget.division}' : ''}',
                              style: const TextStyle(fontSize: 11.5, color: Color(0xFF64748B)),
                            ),
                            trailing: isSelected
                                ? const Icon(Icons.check_circle, color: AppColors.primary, size: 20)
                                : Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFF1F5F9),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: Text(
                                      st.code,
                                      style: const TextStyle(
                                        fontSize: 11,
                                        fontWeight: FontWeight.bold,
                                        color: Color(0xFF475569),
                                      ),
                                    ),
                                  ),
                            onTap: () => widget.onSelected(st),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}
