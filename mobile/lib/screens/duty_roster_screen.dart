import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:io';
import 'package:image_picker/image_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';
import '../widgets/roster_ai_review_dialog.dart';

class DutyRosterScreen extends StatefulWidget {
  final Map<String, dynamic> user;

  const DutyRosterScreen({super.key, required this.user});

  @override
  State<DutyRosterScreen> createState() => _DutyRosterScreenState();
}

class _DutyRosterScreenState extends State<DutyRosterScreen> with SingleTickerProviderStateMixin {
  late TabController _tabController;
  DateTime _selectedDate = DateTime.now();

  int? _stationId;
  Map<String, dynamic>? _stationData;
  List<dynamic> _stations = [];
  List<dynamic> _gates = [];
  List<dynamic> _shifts = [];
  String _shiftConfigName = 'Standard 3-Shift 8hr';
  List<dynamic> _gatemen = [];
  List<dynamic> _roster = [];
  List<dynamic> _myShifts = [];

  // Weekly Gate Roster State (LC-91 Official Chart Format)
  int? _selectedWeeklyGateId;
  DateTime _weeklyStartDate = DateTime.now();
  Map<String, dynamic>? _weeklyRosterData;
  bool _isLoadingWeekly = false;
  bool _isPublishingWeekly = false;
  final Map<String, String> _weeklyDraft = {};
  final ImagePicker _imagePicker = ImagePicker();

  // Local allocations map: key is "${gateId}_${shiftName}", value is gatemanUserId
  final Map<String, int?> _selectedAssignments = {};

  bool _isLoading = true;
  bool _isPublishing = false;
  String _errorMessage = '';

  bool get _isDutyStaff {
    final roleName = ((widget.user['role'] is Map ? widget.user['role']['name'] : widget.user['role']?.toString()) ?? '').toLowerCase();
    final desig = (widget.user['designation'] ?? '').toString().toLowerCase();
    return roleName.contains('gateman') ||
        roleName.contains('restkeeper') ||
        desig.contains('gateman') ||
        desig.contains('restkeeper');
  }

  bool get _isGateman => _isDutyStaff;

  bool get _canManageRoster {
    final roleName = ((widget.user['role'] is Map ? widget.user['role']['name'] : widget.user['role']?.toString()) ?? '').toLowerCase();
    final desig = (widget.user['designation'] ?? '').toString().toLowerCase();
    // Strictly restricted to PWI (Primary author) and CPWI (Secondary/Section Incharge) + Developer/Admin
    return roleName == 'developer' ||
        roleName == 'admin' ||
        roleName.contains('pwi') ||
        roleName.contains('cpwi') ||
        desig.contains('pwi') ||
        desig.contains('sse/p.way') ||
        desig.contains('je/p.way');
  }

  String get _weeklyGateNumber {
    final gate = _weeklyRosterData?['gate'];
    if (gate != null && gate['lcNumber'] != null && gate['lcNumber'].toString().isNotEmpty) {
      return gate['lcNumber'].toString();
    }
    if (_selectedWeeklyGateId != null && _gates.isNotEmpty) {
      final matching = _gates.firstWhere(
        (g) => g['id'] == _selectedWeeklyGateId,
        orElse: () => {},
      );
      if (matching['lcNumber'] != null && matching['lcNumber'].toString().isNotEmpty) {
        return matching['lcNumber'].toString();
      }
    }
    return '';
  }

  @override
  void initState() {
    super.initState();
    // 2 tabs for all: Duty staff has (My Shifts, Weekly LC Roster), Supervisors have (Weekly LC Roster, Daily Matrix)
    _tabController = TabController(length: 2, vsync: this);
    _tabController.addListener(() {
      if (mounted) setState(() {});
    });

    // Snap _weeklyStartDate to Sunday
    final dayOffset = _weeklyStartDate.weekday % 7;
    _weeklyStartDate = _weeklyStartDate.subtract(Duration(days: dayOffset));

    if (widget.user['stationId'] != null) {
      _stationId = widget.user['stationId'] is int
          ? widget.user['stationId'] as int
          : int.tryParse(widget.user['stationId'].toString());
    }

    _loadRosterData().then((_) {
      if (_gates.isNotEmpty) {
        if (_selectedWeeklyGateId == null || !_gates.any((g) => g['id'] == _selectedWeeklyGateId)) {
          _selectedWeeklyGateId = _gates[0]['id'] as int;
        }
        _loadWeeklyRosterData();
      }
    });

    if (_isDutyStaff) {
      _loadMyShifts();
    }
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<String> _getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token') ?? '';
  }

  String _formatDate(DateTime d) {
    final y = d.year.toString().padLeft(4, '0');
    final m = d.month.toString().padLeft(2, '0');
    final day = d.day.toString().padLeft(2, '0');
    return '$y-$m-$day';
  }

  String _formatDisplayDate(DateTime d) {
    final now = DateTime.now();
    final isToday = d.year == now.year && d.month == now.month && d.day == now.day;
    final months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    final days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    final weekday = days[d.weekday - 1];
    final mStr = months[d.month - 1];
    if (isToday) {
      return 'Today ($weekday, ${d.day} $mStr ${d.year})';
    }
    return '$weekday, ${d.day} $mStr ${d.year}';
  }

  Future<void> _loadRosterData() async {
    setState(() {
      _isLoading = true;
      _errorMessage = '';
    });

    try {
      final token = await _getToken();
      final dateStr = _formatDate(_selectedDate);
      final queryParams = <String, String>{'date': dateStr};
      if (_stationId != null) queryParams['stationId'] = _stationId.toString();

      final uri = Uri.parse('$baseUrl/roster').replace(queryParameters: queryParams);
      final res = await http.get(uri, headers: {'Authorization': 'Bearer $token'});

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        setState(() {
          _stationData = data['station'];
          if (_stationData != null && _stationData!['id'] != null) {
            _stationId = _stationData!['id'] as int;
          }
          if (data['stations'] is List) {
            _stations = data['stations'];
          }
          _gates = data['gates'] ?? [];
          final shiftCfg = data['shiftConfig'] ?? {};
          _shifts = shiftCfg['shifts'] ?? [];
          _shiftConfigName = shiftCfg['name'] ?? 'Shift Schedule';
          _gatemen = data['gatemen'] ?? [];
          _roster = data['roster'] ?? [];

          // Prepopulate assignments map from existing server roster entries
          _selectedAssignments.clear();
          for (var r in _roster) {
            final key = '${r['gateId']}_${r['shiftName']}';
            _selectedAssignments[key] = r['gatemanId'];
          }
          _isLoading = false;
        });
      } else {
        setState(() {
          _errorMessage = 'Failed to load roster data (${res.statusCode})';
          _isLoading = false;
        });
      }
    } catch (e) {
      setState(() {
        _errorMessage = 'Network error loading roster: $e';
        _isLoading = false;
      });
    }
  }

  Future<void> _loadMyShifts() async {
    try {
      final token = await _getToken();
      final res = await http.get(
        Uri.parse('$baseUrl/roster/my-shifts'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _myShifts = data['shifts'] ?? [];
          });
        }
      }
    } catch (_) {}
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime(2020),
      lastDate: DateTime.now().add(const Duration(days: 90)),
      helpText: 'SELECT ROSTER DATE',
    );
    if (picked != null && picked != _selectedDate) {
      setState(() => _selectedDate = picked);
      _loadRosterData();
    }
  }

  void _nextDay() {
    setState(() => _selectedDate = _selectedDate.add(const Duration(days: 1)));
    _loadRosterData();
  }

  void _previousDay() {
    setState(() => _selectedDate = _selectedDate.subtract(const Duration(days: 1)));
    _loadRosterData();
  }

  Widget _buildExamBadge(String type, String? status) {
    final stat = (status ?? 'NOT_SET').toUpperCase();
    final Color color;
    final String label;

    if (stat == 'VALID') {
      color = const Color(0xFF059669);
      label = '$type: Valid';
    } else if (stat == 'DUE_SOON') {
      color = const Color(0xFFD97706);
      label = '$type: Due';
    } else if (stat == 'EXPIRED') {
      color = const Color(0xFFDC2626);
      label = '$type: Expired';
    } else {
      color = const Color(0xFF64748B);
      label = '$type: -';
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        label,
        style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.bold, color: color),
      ),
    );
  }

  Map<String, Color> _getShiftColors(String code) {
    if (code == 'W/R') {
      return {'text': const Color(0xFFB45309), 'bg': const Color(0xFFFEF3C7)};
    } else if (code == 'N/R') {
      return {'text': const Color(0xFFC2410C), 'bg': const Color(0xFFFFEDD5)};
    } else if (code == '-') {
      return {'text': const Color(0xFF64748B), 'bg': const Color(0xFFF1F5F9)};
    } else if (code.contains(',') || code.contains('&')) {
      return {'text': const Color(0xFF7E22CE), 'bg': const Color(0xFFF3E8FF)};
    }

    final shiftPalette = [
      {'text': const Color(0xFF15803D), 'bg': const Color(0xFFDCFCE7)}, // Green
      {'text': const Color(0xFF4338CA), 'bg': const Color(0xFFEEF2FF)}, // Indigo
      {'text': const Color(0xFF0369A1), 'bg': const Color(0xFFE0F2FE)}, // Sky Blue
      {'text': const Color(0xFF0F766E), 'bg': const Color(0xFFCCFBF1)}, // Teal
      {'text': const Color(0xFF7C3AED), 'bg': const Color(0xFFF3E8FF)}, // Purple
      {'text': const Color(0xFFD97706), 'bg': const Color(0xFFFEF3C7)}, // Amber
    ];

    for (int i = 0; i < _shifts.length; i++) {
      final s = _shifts[i];
      final start = (s['startTime'] ?? '').toString();
      final end = (s['endTime'] ?? '').toString();
      final sStartHr = start.split(':').first.padLeft(2, '0');
      final sEndHr = (end == '24:00' ? '24' : end.split(':').first).padLeft(2, '0');
      if (code == '$sStartHr-$sEndHr' || code == '${start.split(':').first}-${end.split(':').first}') {
        return shiftPalette[i % shiftPalette.length];
      }
    }

    if (code == '07-19') {
      return {'text': const Color(0xFF15803D), 'bg': const Color(0xFFDCFCE7)};
    } else if (code == '19-24') {
      return {'text': const Color(0xFF4338CA), 'bg': const Color(0xFFEEF2FF)};
    } else if (code == '00-07') {
      return {'text': const Color(0xFF0369A1), 'bg': const Color(0xFFE0F2FE)};
    }

    return {'text': const Color(0xFF0F766E), 'bg': const Color(0xFFCCFBF1)};
  }

  void _openStationSelectionDialog() {
    if (_stations.isEmpty) return;
    String searchQuery = '';

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            final filteredStations = _stations.where((st) {
              final q = searchQuery.trim().toLowerCase();
              if (q.isEmpty) return true;
              final name = (st['name'] ?? '').toString().toLowerCase();
              final code = (st['code'] ?? '').toString().toLowerCase();
              return name.contains(q) || code.contains(q);
            }).toList();

            return SafeArea(
              child: Padding(
                padding: EdgeInsets.only(
                  left: 18,
                  right: 18,
                  top: 20,
                  bottom: MediaQuery.of(ctx).viewInsets.bottom + 16,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Row(
                          children: [
                            Icon(Icons.train_outlined, color: AppColors.primary, size: 22),
                            SizedBox(width: 8),
                            Text('Select Station', style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
                          ],
                        ),
                        IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                      ],
                    ),
                    Text(
                      'Switch station to view and manage its LC gates and duty shifts.',
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      decoration: InputDecoration(
                        hintText: 'Search station by name or code...',
                        prefixIcon: const Icon(Icons.search, size: 20),
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        isDense: true,
                        filled: true,
                        fillColor: const Color(0xFFF1F5F9),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
                      ),
                      onChanged: (val) => setSheetState(() => searchQuery = val),
                    ),
                    const SizedBox(height: 12),
                    ConstrainedBox(
                      constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.45),
                      child: filteredStations.isEmpty
                          ? const Center(
                              child: Padding(
                                padding: EdgeInsets.all(24),
                                child: Text('No stations match search criteria.'),
                              ),
                            )
                          : ListView.separated(
                              shrinkWrap: true,
                              itemCount: filteredStations.length,
                              separatorBuilder: (context, index) => const Divider(height: 1),
                              itemBuilder: (context, idx) {
                                final st = filteredStations[idx];
                                final isSelected = st['id'] == _stationId;
                                final gatesCount = (st['_count'] is Map && st['_count']['gates'] != null)
                                    ? st['_count']['gates'] as int
                                    : ((st['gates'] is List) ? (st['gates'] as List).length : null);
                                final subtitleText = gatesCount != null && gatesCount > 0
                                    ? '${st['division'] ?? 'Division'} • $gatesCount LC Gate${gatesCount == 1 ? '' : 's'}'
                                    : '${st['division'] ?? 'Division'} • 0 LC Gates';

                                return ListTile(
                                  contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                  leading: Container(
                                    padding: const EdgeInsets.all(8),
                                    decoration: BoxDecoration(
                                      color: isSelected ? AppColors.primary.withValues(alpha: 0.12) : const Color(0xFFF1F5F9),
                                      shape: BoxShape.circle,
                                    ),
                                    child: Icon(Icons.location_on, size: 18, color: isSelected ? AppColors.primary : Colors.grey.shade600),
                                  ),
                                  title: Text(
                                    '${st['name']} (${st['code']})',
                                    style: TextStyle(
                                      fontWeight: isSelected ? FontWeight.bold : FontWeight.w600,
                                      fontSize: 14,
                                      color: isSelected ? AppColors.primary : const Color(0xFF0F172A),
                                    ),
                                  ),
                                  subtitle: Text(
                                    subtitleText,
                                    style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                                  ),
                                  trailing: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      if (gatesCount != null && gatesCount > 0)
                                        Container(
                                          margin: const EdgeInsets.only(right: 6),
                                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                          decoration: BoxDecoration(
                                            color: const Color(0xFFDCFCE7),
                                            borderRadius: BorderRadius.circular(4),
                                            border: Border.all(color: const Color(0xFF86EFAC)),
                                          ),
                                          child: Text(
                                            '$gatesCount Gate${gatesCount == 1 ? '' : 's'}',
                                            style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF166534)),
                                          ),
                                        ),
                                      if (isSelected) const Icon(Icons.check_circle, color: AppColors.primary, size: 20),
                                    ],
                                  ),
                                  onTap: () {
                                    Navigator.pop(ctx);
                                    if (st['id'] != _stationId) {
                                      setState(() {
                                        _stationId = st['id'];
                                        _stationData = st;
                                        _selectedWeeklyGateId = null;
                                        _gates.clear();
                                      });
                                      _loadRosterData().then((_) {
                                        if (_gates.isNotEmpty) {
                                          _selectedWeeklyGateId = _gates[0]['id'] as int;
                                          _loadWeeklyRosterData();
                                        }
                                      });
                                    }
                                  },
                                );
                              },
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

  void _openShiftConfigDialog() {
    final List<Map<String, String>> localShifts = _shifts.map((s) => {
      'id': (s['id'] ?? '').toString(),
      'name': (s['name'] ?? '').toString(),
      'startTime': (s['startTime'] ?? '').toString(),
      'endTime': (s['endTime'] ?? '').toString(),
    }).toList();

    String templateName = _shiftConfigName;
    bool applyToGateOnly = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setModalState) {
            return Padding(
              padding: EdgeInsets.only(
                left: 18,
                right: 18,
                top: 20,
                bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Row(
                        children: [
                          Icon(Icons.tune_rounded, color: AppColors.primary, size: 22),
                          SizedBox(width: 8),
                          Text('Shift Schedule Configurator', style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
                        ],
                      ),
                      IconButton(
                        icon: const Icon(Icons.close),
                        onPressed: () => Navigator.pop(ctx),
                      ),
                    ],
                  ),
                  Text(
                    'Configure dynamic shift count and start/end timings for ${_stationData?['name'] ?? 'Station'}.',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                  ),
                  const SizedBox(height: 12),

                  // Configuration Target Scope
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF1F5F9),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: const Color(0xFFE2E8F0)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Configuration Target:',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155)),
                        ),
                        const SizedBox(height: 6),
                        Row(
                          children: [
                            Expanded(
                              child: InkWell(
                                onTap: () => setModalState(() => applyToGateOnly = false),
                                borderRadius: BorderRadius.circular(8),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 8),
                                  decoration: BoxDecoration(
                                    color: !applyToGateOnly ? AppColors.primary : Colors.white,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(
                                      color: !applyToGateOnly ? AppColors.primary : Colors.grey.shade300,
                                    ),
                                  ),
                                  alignment: Alignment.center,
                                  child: Text(
                                    'Station Fleet (${_stationData?['name'] ?? 'Station'})',
                                    style: TextStyle(
                                      fontSize: 11.5,
                                      fontWeight: FontWeight.bold,
                                      color: !applyToGateOnly ? Colors.white : const Color(0xFF475569),
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: InkWell(
                                onTap: _selectedWeeklyGateId != null
                                    ? () => setModalState(() => applyToGateOnly = true)
                                    : null,
                                borderRadius: BorderRadius.circular(8),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 8),
                                  decoration: BoxDecoration(
                                    color: applyToGateOnly ? AppColors.primary : Colors.white,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(
                                      color: applyToGateOnly ? AppColors.primary : Colors.grey.shade300,
                                    ),
                                  ),
                                  alignment: Alignment.center,
                                  child: Text(
                                    _weeklyGateNumber.isNotEmpty ? 'This Gate ($_weeklyGateNumber)' : 'Selected Gate Only',
                                    style: TextStyle(
                                      fontSize: 11.5,
                                      fontWeight: FontWeight.bold,
                                      color: applyToGateOnly ? Colors.white : const Color(0xFF475569),
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),

                  // Quick Presets
                  const Text('Standard Presets:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 8),
                            side: BorderSide(color: templateName.contains('8hr') ? AppColors.primary : Colors.grey.shade300),
                            backgroundColor: templateName.contains('8hr') ? AppColors.primary.withValues(alpha: 0.08) : Colors.white,
                          ),
                          onPressed: () {
                            setModalState(() {
                              templateName = 'Standard 3-Shift 8hr';
                              localShifts.clear();
                              localShifts.addAll([
                                {'id': 'shift_1', 'name': 'Morning Shift', 'startTime': '06:00', 'endTime': '14:00'},
                                {'id': 'shift_2', 'name': 'Evening Shift', 'startTime': '14:00', 'endTime': '22:00'},
                                {'id': 'shift_3', 'name': 'Night Shift', 'startTime': '22:00', 'endTime': '06:00'},
                              ]);
                            });
                          },
                          child: const Text('3 Shifts (8h)', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 8),
                            side: BorderSide(color: templateName.contains('12hr') ? AppColors.primary : Colors.grey.shade300),
                            backgroundColor: templateName.contains('12hr') ? AppColors.primary.withValues(alpha: 0.08) : Colors.white,
                          ),
                          onPressed: () {
                            setModalState(() {
                              templateName = 'Standard 2-Shift 12hr';
                              localShifts.clear();
                              localShifts.addAll([
                                {'id': 'shift_1', 'name': 'Day Shift', 'startTime': '08:00', 'endTime': '20:00'},
                                {'id': 'shift_2', 'name': 'Night Shift', 'startTime': '20:00', 'endTime': '08:00'},
                              ]);
                            });
                          },
                          child: const Text('2 Shifts (12h)', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 8),
                            side: BorderSide(color: templateName.contains('LC-91') ? AppColors.primary : Colors.grey.shade300),
                            backgroundColor: templateName.contains('LC-91') ? AppColors.primary.withValues(alpha: 0.08) : Colors.white,
                          ),
                          onPressed: () {
                            setModalState(() {
                              templateName = 'LC-91 Standard 3-Shift';
                              localShifts.clear();
                              localShifts.addAll([
                                {'id': 'shift_1', 'name': 'Day Shift', 'startTime': '07:00', 'endTime': '19:00'},
                                {'id': 'shift_2', 'name': 'Evening Shift', 'startTime': '19:00', 'endTime': '24:00'},
                                {'id': 'shift_3', 'name': 'Night Shift', 'startTime': '00:00', 'endTime': '07:00'},
                              ]);
                            });
                          },
                          child: const Text('LC-91 (3-Shift)', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),

                  // Active Shifts List
                  const Text('Active Shift Intervals:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
                  const SizedBox(height: 6),
                  ...localShifts.asMap().entries.map((entry) {
                    final idx = entry.key;
                    final s = entry.value;
                    return Container(
                      margin: const EdgeInsets.only(bottom: 8),
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF8FAFC),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFE2E8F0)),
                      ),
                      child: Row(
                        children: [
                          Container(
                            width: 22,
                            height: 22,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(color: AppColors.primary, borderRadius: BorderRadius.circular(11)),
                            child: Text('${idx + 1}', style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold)),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            flex: 3,
                            child: TextFormField(
                              initialValue: s['name'],
                              decoration: const InputDecoration(isDense: true, border: InputBorder.none, hintText: 'Shift Name'),
                              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold),
                              onChanged: (val) => s['name'] = val,
                            ),
                          ),
                          InkWell(
                            onTap: () async {
                              final parts = s['startTime']!.split(':');
                              final initial = TimeOfDay(hour: int.tryParse(parts[0]) ?? 6, minute: int.tryParse(parts[1]) ?? 0);
                              final picked = await showTimePicker(context: ctx, initialTime: initial);
                              if (picked != null) {
                                setModalState(() {
                                  s['startTime'] = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
                                });
                              }
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(4), border: Border.all(color: Colors.grey.shade300)),
                              child: Text(s['startTime']!, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary)),
                            ),
                          ),
                          const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 4),
                            child: Text('-', style: TextStyle(fontWeight: FontWeight.bold)),
                          ),
                          InkWell(
                            onTap: () async {
                              final parts = s['endTime']!.split(':');
                              final initial = TimeOfDay(hour: int.tryParse(parts[0]) ?? 14, minute: int.tryParse(parts[1]) ?? 0);
                              final picked = await showTimePicker(context: ctx, initialTime: initial);
                              if (picked != null) {
                                setModalState(() {
                                  s['endTime'] = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
                                });
                              }
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(4), border: Border.all(color: Colors.grey.shade300)),
                              child: Text(s['endTime']!, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary)),
                            ),
                          ),
                          if (localShifts.length > 1) ...[
                            IconButton(
                              icon: const Icon(Icons.remove_circle_outline, color: Colors.red, size: 18),
                              onPressed: () => setModalState(() => localShifts.removeAt(idx)),
                            ),
                          ],
                        ],
                      ),
                    );
                  }),
                  TextButton.icon(
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('Add Another Shift Slot', style: TextStyle(fontSize: 12)),
                    onPressed: () {
                      setModalState(() {
                        final num = localShifts.length + 1;
                        localShifts.add({'id': 'shift_$num', 'name': 'Shift $num', 'startTime': '00:00', 'endTime': '08:00'});
                        templateName = 'Custom Shift Schedule';
                      });
                    },
                  ),
                  const SizedBox(height: 16),

                  // Save Button
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                      onPressed: () async {
                        Navigator.pop(ctx);
                        await _saveShiftConfig(
                          templateName,
                          localShifts,
                          targetGateId: applyToGateOnly ? _selectedWeeklyGateId : null,
                        );
                      },
                      child: const Text('Save & Apply Shift Schedule', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
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

  Future<void> _saveShiftConfig(String name, List<Map<String, String>> shifts, {int? targetGateId}) async {
    setState(() => _isLoading = true);
    try {
      final token = await _getToken();
      final body = {
        'stationId': _stationId,
        'gateId': targetGateId,
        'name': name,
        'shifts': shifts,
      };

      final res = await http.post(
        Uri.parse('$baseUrl/shifts/config'),
        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
        body: json.encode(body),
      );

      if (res.statusCode == 200) {
        if (mounted) {
          AppFeedback.showSuccess(
            context,
            targetGateId != null
                ? 'Shift timings applied specifically to $_weeklyGateNumber.'
                : 'Shift timings applied across ${_stationData?['name'] ?? 'station'} fleet.',
          );
        }
        _loadRosterData().then((_) {
          if (_selectedWeeklyGateId != null) {
            _loadWeeklyRosterData();
          }
        });
      } else {
        if (mounted) {
          AppFeedback.showError(context, 'Failed to update shift schedule.');
        }
        setState(() => _isLoading = false);
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Error saving shifts: $e');
      }
      setState(() => _isLoading = false);
    }
  }

  Future<void> _publishRoster() async {
    if (_isPublishing) return;

    final assignments = <Map<String, dynamic>>[];
    for (var g in _gates) {
      final gateId = g['id'] as int;
      for (var s in _shifts) {
        final shiftName = s['name'].toString();
        final key = '${gateId}_$shiftName';
        final gatemanId = _selectedAssignments[key];
        if (gatemanId != null && gatemanId > 0) {
          assignments.add({
            'gateId': gateId,
            'shiftName': shiftName,
            'startTime': s['startTime'],
            'endTime': s['endTime'],
            'gatemanId': gatemanId,
          });
        }
      }
    }

    if (assignments.isEmpty) {
      AppFeedback.showWarning(context, 'Please assign at least one Gateman to a shift before publishing.');
      return;
    }

    setState(() => _isPublishing = true);

    try {
      final token = await _getToken();
      final dateStr = _formatDate(_selectedDate);

      final body = {
        'stationId': _stationId,
        'date': dateStr,
        'assignments': assignments,
      };

      final res = await http.post(
        Uri.parse('$baseUrl/roster/publish'),
        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
        body: json.encode(body),
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final count = data['count'] ?? assignments.length;
        if (mounted) {
          AppFeedback.showSuccess(
            context,
            'Duty roster published for $dateStr! $count shift(s) allocated. Email reminders dispatched to Gatemen.',
          );
        }
        _loadRosterData();
      } else {
        final err = json.decode(res.body)['error'] ?? 'Failed to publish roster.';
        if (mounted) {
          AppFeedback.showError(context, err);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error publishing roster: $e');
      }
    } finally {
      if (mounted) {
        setState(() => _isPublishing = false);
      }
    }
  }


  // =========================================================================
  // WEEKLY LC GATE ROSTER (LC-91 Physical Chart Model)
  // =========================================================================

  Future<void> _loadWeeklyRosterData({int? gateId, DateTime? weekStart}) async {
    final gid = gateId ?? _selectedWeeklyGateId ?? (_gates.isNotEmpty ? _gates[0]['id'] : null);
    if (gid == null) return;
    _selectedWeeklyGateId = gid;

    DateTime start = weekStart ?? _weeklyStartDate;
    // Snap to Sunday (weekday 7 in Dart)
    final dayOffset = start.weekday % 7;
    start = start.subtract(Duration(days: dayOffset));
    _weeklyStartDate = start;

    setState(() => _isLoadingWeekly = true);
    try {
      final token = await _getToken();
      final weekStartStr = _formatDate(start);
      final uri = Uri.parse('$baseUrl/roster/weekly?gateId=$gid&weekStartDate=$weekStartStr');
      final res = await http.get(uri, headers: {'Authorization': 'Bearer $token'});

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _weeklyRosterData = data;
            if (data['shiftConfig'] != null && data['shiftConfig']['shifts'] is List) {
              _shifts = data['shiftConfig']['shifts'];
              _shiftConfigName = data['shiftConfig']['name'] ?? 'Shift Schedule';
            }
            _weeklyDraft.clear();
            final matrix = (data['matrix'] as List?) ?? [];
            for (final staff in matrix) {
              final uid = staff['userId'].toString();
              final schedule = staff['schedule'] as Map<String, dynamic>? ?? {};
              schedule.forEach((day, item) {
                _weeklyDraft['${uid}_$day'] = (item['shiftCode'] ?? '-').toString();
              });
            }
            _isLoadingWeekly = false;
          });
        }
      } else {
        if (mounted) setState(() => _isLoadingWeekly = false);
      }
    } catch (e) {
      debugPrint('Error loading weekly roster: $e');
      if (mounted) setState(() => _isLoadingWeekly = false);
    }
  }

  void _nextWeek() {
    _loadWeeklyRosterData(weekStart: _weeklyStartDate.add(const Duration(days: 7)));
  }

  void _previousWeek() {
    _loadWeeklyRosterData(weekStart: _weeklyStartDate.subtract(const Duration(days: 7)));
  }

  Future<void> _pickWeekStartDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _weeklyStartDate,
      firstDate: DateTime(2020),
      lastDate: DateTime.now().add(const Duration(days: 180)),
      helpText: 'SELECT WEEK START DATE',
    );
    if (picked != null) {
      _loadWeeklyRosterData(weekStart: picked);
    }
  }

  void _showShiftPickerSheet(int userId, String staffName, String dayOfWeek, String dateStr) {
    if (!_canManageRoster) return;

    final currentCode = _weeklyDraft['${userId}_$dayOfWeek'] ?? '-';

    final options = <Map<String, dynamic>>[];

    final shiftPalette = [
      const Color(0xFF16A34A), // Green
      const Color(0xFF4F46E5), // Indigo
      const Color(0xFF0284C7), // Blue
      const Color(0xFF0891B2), // Cyan
      const Color(0xFF7C3AED), // Purple
      const Color(0xFFD97706), // Amber
    ];

    if (_shifts.isNotEmpty) {
      for (int i = 0; i < _shifts.length; i++) {
        final s = _shifts[i];
        final name = s['name'] ?? 'Shift ${i + 1}';
        final start = (s['startTime'] ?? '00:00').toString();
        final end = (s['endTime'] ?? '00:00').toString();

        final startHour = start.split(':')[0].padLeft(2, '0');
        final endHour = (end == '24:00' ? '24' : end.split(':')[0]).padLeft(2, '0');
        final code = '$startHour-$endHour';
        final color = shiftPalette[i % shiftPalette.length];

        options.add({
          'code': code,
          'label': '$name ($start - $end)',
          'desc': '$name Duty Timing',
          'color': color,
        });
      }
    } else {
      options.addAll([
        {'code': '07-19', 'label': 'Day Shift (07:00 - 19:00)', 'desc': '12h Standard Day Duty', 'color': const Color(0xFF16A34A)},
        {'code': '19-24', 'label': 'Evening Shift (19:00 - 24:00)', 'desc': '5h Night Duty Part 1', 'color': const Color(0xFF4F46E5)},
        {'code': '00-07', 'label': 'Night Shift (00:00 - 07:00)', 'desc': '7h Night Duty Part 2', 'color': const Color(0xFF0284C7)},
      ]);
    }

    if (_shifts.length == 3 && options.any((o) => o['code'] == '00-07') && options.any((o) => o['code'] == '19-24')) {
      options.add({
        'code': '00-07, 19-24',
        'label': 'Split Shift (00-07 & 19-24)',
        'desc': 'Continuous 24h Coverage Split',
        'color': const Color(0xFF9333EA),
      });
    }

    options.addAll([
      {'code': 'W/R', 'label': 'Weekly Rest (W/R)', 'desc': '30 Hours Mandatory Consecutive Rest', 'color': const Color(0xFFD97706)},
      {'code': 'N/R', 'label': 'Night Rest (N/R)', 'desc': 'Post-Night Shift Rest Period', 'color': const Color(0xFFEA580C)},
      {'code': '-', 'label': 'Relief / Off Duty (-)', 'desc': 'Covered by Restkeeper or Spare', 'color': const Color(0xFF64748B)},
    ]);

    if (currentCode != '-' && !options.any((o) => o['code'] == currentCode)) {
      options.insert(0, {
        'code': currentCode,
        'label': 'Custom Shift ($currentCode)',
        'desc': 'Current Assigned Code',
        'color': const Color(0xFF0D9488),
      });
    }

    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Assign Shift: $dayOfWeek', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                        Text('$staffName • $dateStr', style: const TextStyle(fontSize: 12, color: Color(0xFF64748B))),
                      ],
                    ),
                    IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                  ],
                ),
                const Divider(),
                ...options.map((opt) {
                  final code = opt['code'] as String;
                  final label = opt['label'] as String;
                  final desc = opt['desc'] as String;
                  final color = opt['color'] as Color;
                  final isSelected = currentCode == code;

                  return ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    leading: Container(
                      width: 44,
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: color.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: color, width: 1.5),
                      ),
                      child: Text(
                        code,
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: color),
                      ),
                    ),
                    title: Text(label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                    subtitle: Text(desc, style: const TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                    trailing: isSelected ? const Icon(Icons.check_circle, color: Color(0xFF16A34A)) : null,
                    onTap: () {
                      Navigator.pop(ctx);
                      setState(() {
                        _weeklyDraft['${userId}_$dayOfWeek'] = code;
                      });
                    },
                  );
                }),
              ],
            ),
          ),
        );
      },
    );
  }

  void _openPublishScopeDialog() {
    if (_selectedWeeklyGateId == null || _weeklyRosterData == null) return;
    final hasOverrides = _weeklyRosterData!['hasOverridesThisWeek'] == true;
    final weekStartStr = _weeklyRosterData!['weekStartDate'] ?? '';

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Row(
                      children: [
                        Icon(Icons.rule_folder_outlined, color: AppColors.primary, size: 22),
                        SizedBox(width: 8),
                        Text('Select Roster Application Scope', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                      ],
                    ),
                    IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                  ],
                ),
                Text(
                  'Choose whether this updated roster applies as the Permanent Master Cycle (all 52 weeks) or as a temporary exception for this week only.',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                ),
                const SizedBox(height: 16),

                // Option 1: Permanent Master Cycle (Yearly 52 Weeks)
                InkWell(
                  onTap: () {
                    Navigator.pop(ctx);
                    _executePublishWeekly(mode: 'PERMANENT');
                  },
                  borderRadius: BorderRadius.circular(10),
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFEFF6FF),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: const Color(0xFF93C5FD), width: 1.5),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: const BoxDecoration(color: Color(0xFF1D4ED8), shape: BoxShape.circle),
                          child: const Icon(Icons.all_inclusive, color: Colors.white, size: 20),
                        ),
                        const SizedBox(width: 12),
                        const Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Permanent Master Cycle (Yearly)',
                                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5, color: Color(0xFF1E3A8A)),
                              ),
                              SizedBox(height: 3),
                              Text(
                                'Applies automatically to all 52 weeks (365 days). Standard cyclical roster sanctioned by SSE/P.WAY & ADEN. No weekly manual re-entry needed.',
                                style: TextStyle(fontSize: 11, color: Color(0xFF334155), height: 1.3),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),

                // Option 2: Specific Week Only (Temporary Exception)
                InkWell(
                  onTap: () {
                    Navigator.pop(ctx);
                    _executePublishWeekly(mode: 'SPECIFIC_WEEK');
                  },
                  borderRadius: BorderRadius.circular(10),
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFFFBEB),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: const Color(0xFFFCD34D), width: 1.5),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: const BoxDecoration(color: Color(0xFFD97706), shape: BoxShape.circle),
                          child: const Icon(Icons.date_range, color: Colors.white, size: 20),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Specific Week Only ($weekStartStr)',
                                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5, color: Color(0xFF92400E)),
                              ),
                              const SizedBox(height: 3),
                              const Text(
                                'Temporary override for this week only (e.g. sick leave, PME course, or Restkeeper relief). Leaves the permanent cycle for all other weeks completely untouched.',
                                style: TextStyle(fontSize: 11, color: Color(0xFF334155), height: 1.3),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),

                // Option 3: Reset Week to Permanent Cycle (if overrides exist)
                if (hasOverrides) ...[
                  const SizedBox(height: 12),
                  InkWell(
                    onTap: () {
                      Navigator.pop(ctx);
                      _executePublishWeekly(mode: 'RESET');
                    },
                    borderRadius: BorderRadius.circular(10),
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF1F5F9),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0xFFCBD5E1)),
                      ),
                      child: const Row(
                        children: [
                          Icon(Icons.restart_alt, color: Color(0xFF64748B), size: 22),
                          SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Reset This Week to Permanent Cycle',
                                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF334155)),
                                ),
                                Text(
                                  'Clears all temporary overrides for this week and reverts back to the standard cycle.',
                                  style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _executePublishWeekly({required String mode}) async {
    if (_selectedWeeklyGateId == null || _weeklyRosterData == null) return;

    final days = (_weeklyRosterData!['days'] as List?) ?? [];
    final matrix = (_weeklyRosterData!['matrix'] as List?) ?? [];

    final assignments = <Map<String, dynamic>>[];

    if (mode != 'RESET') {
      for (final staff in matrix) {
        final uid = staff['userId'];
        for (final d in days) {
          final dayOfWeek = d['dayOfWeek'].toString();
          final dateStr = d['date'].toString();
          final code = _weeklyDraft['${uid}_$dayOfWeek'] ?? '-';

          String startTime = '00:00';
          String endTime = '00:00';
          bool isSplit = false;
          String? secStart;
          String? secEnd;

          if (code == 'W/R' || code == 'N/R' || code == '-') {
            startTime = '00:00';
            endTime = '00:00';
          } else if (code.contains(',') || code.contains('&')) {
            isSplit = true;
            startTime = '00:00';
            endTime = '07:00';
            secStart = '19:00';
            secEnd = '24:00';
          } else {
            final matchedShift = _shifts.firstWhere((s) {
              final start = (s['startTime'] ?? '').toString();
              final end = (s['endTime'] ?? '').toString();
              final sStartHr = start.split(':').first.padLeft(2, '0');
              final sEndHr = (end == '24:00' ? '24' : end.split(':').first).padLeft(2, '0');
              return code == '$sStartHr-$sEndHr' || code == '${start.split(':').first}-${end.split(':').first}';
            }, orElse: () => null);

            if (matchedShift != null) {
              startTime = matchedShift['startTime'] ?? '08:00';
              endTime = matchedShift['endTime'] ?? '20:00';
            } else if (code == '07-19') {
              startTime = '07:00';
              endTime = '19:00';
            } else if (code == '19-24') {
              startTime = '19:00';
              endTime = '24:00';
            } else if (code == '00-07') {
              startTime = '00:00';
              endTime = '07:00';
            } else if (code.contains('-')) {
              final parts = code.split('-');
              final p0 = parts[0].trim().padLeft(2, '0');
              final p1 = parts[1].trim().padLeft(2, '0');
              startTime = '$p0:00';
              endTime = p1 == '24' ? '24:00' : '$p1:00';
            }
          }

          assignments.add({
            'gatemanId': uid,
            'gatemanUserId': uid,
            'date': dateStr,
            'dayOfWeek': dayOfWeek,
            'shiftCode': code,
            'startTime': startTime,
            'endTime': endTime,
            'isSplitShift': isSplit,
            'secondaryStart': secStart,
            'secondaryEnd': secEnd,
          });
        }
      }
    }

    setState(() => _isPublishingWeekly = true);
    try {
      final token = await _getToken();
      final body = {
        'gateId': _selectedWeeklyGateId,
        'weekStartDate': _weeklyRosterData?['weekStartDate'] ?? _formatDate(_weeklyStartDate),
        'mode': mode,
        if (mode != 'RESET') 'assignments': assignments,
      };

      final res = await http.post(
        Uri.parse('$baseUrl/roster/publish-weekly'),
        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
        body: json.encode(body),
      );

      if (res.statusCode >= 200 && res.statusCode < 300) {
        final data = json.decode(res.body);
        final msg = data['message'] ?? 'Roster changes published successfully!';
        if (mounted) {
          AppFeedback.showSuccess(context, msg);
        }
        await _loadWeeklyRosterData();
      } else {
        final err = json.decode(res.body)['error'] ?? 'Failed to publish weekly roster.';
        if (mounted) AppFeedback.showError(context, err);
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Network error publishing weekly roster: $e');
    } finally {
      if (mounted) setState(() => _isPublishingWeekly = false);
    }
  }

  Future<void> _openRosterScanPicker() async {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: const Color(0xFF10B981).withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Icon(Icons.document_scanner_rounded, color: Color(0xFF10B981), size: 22),
                    ),
                    const SizedBox(width: 10),
                    const Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Scan Physical Roster Sheet',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A)),
                        ),
                        Text(
                          'Google Gemini 3.5 Flash Vision OCR',
                          style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                        ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                ListTile(
                  leading: Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Icon(Icons.camera_alt_rounded, color: AppColors.primary),
                  ),
                  title: const Text('Take Photo with Camera', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                  subtitle: const Text('Capture live physical duty chart or register', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                  trailing: const Icon(Icons.chevron_right_rounded, color: Color(0xFF94A3B8)),
                  onTap: () {
                    Navigator.pop(ctx);
                    _pickAndScanRoster(ImageSource.camera);
                  },
                ),
                const Divider(height: 1),
                ListTile(
                  leading: Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: const Color(0xFF8B5CF6).withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Icon(Icons.photo_library_rounded, color: Color(0xFF8B5CF6)),
                  ),
                  title: const Text('Upload from Gallery / Files', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                  subtitle: const Text('Pick scanned chart or saved photo', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                  trailing: const Icon(Icons.chevron_right_rounded, color: Color(0xFF94A3B8)),
                  onTap: () {
                    Navigator.pop(ctx);
                    _pickAndScanRoster(ImageSource.gallery);
                  },
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _pickAndScanRoster(ImageSource source) async {
    try {
      final picked = await _imagePicker.pickImage(source: source, imageQuality: 90);
      if (picked == null || !mounted) return;

      final imageFile = File(picked.path);

      // Show Progress Dialog
      showDialog(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          content: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
            child: Row(
              children: [
                const SizedBox(
                  width: 28,
                  height: 28,
                  child: CircularProgressIndicator(strokeWidth: 3, color: AppColors.primary),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Scanning Duty Roster...',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Gemini AI reading gate, shifts & staff allocations...',
                        style: TextStyle(fontSize: 11.5, color: Colors.grey),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      );

      final token = await _getToken();
      final uri = Uri.parse('$baseUrl/roster/scan-chart');
      final request = http.MultipartRequest('POST', uri);
      request.headers['Authorization'] = 'Bearer $token';

      if (_selectedWeeklyGateId != null) {
        request.fields['gateId'] = _selectedWeeklyGateId.toString();
      }
      if (_stationId != null) {
        request.fields['stationId'] = _stationId.toString();
      }
      request.fields['weekStartDate'] = _formatDate(_weeklyStartDate);
      request.files.add(await http.MultipartFile.fromPath('image', imageFile.path));

      final streamedResponse = await request.send();
      final response = await http.Response.fromStream(streamedResponse);

      if (mounted) {
        Navigator.of(context, rootNavigator: true).pop(); // dismiss loading dialog
      }

      if (response.statusCode == 200) {
        final resJson = json.decode(response.body);
        final scanResult = (resJson['data'] as Map<String, dynamic>?) ?? {};

        if (mounted) {
          showDialog(
            context: context,
            barrierDismissible: false,
            builder: (ctx) => RosterAiReviewDialog(
              imageFile: imageFile,
              scanResult: scanResult,
              onApply: (reconciledData, publishNow) {
                _applyReconciledAiRoster(reconciledData, publishNow: publishNow);
              },
            ),
          );
        }
      } else {
        String errMsg = 'Failed to analyze roster chart.';
        try {
          final errJson = json.decode(response.body);
          if (errJson['error'] != null) errMsg = errJson['error'];
        } catch (_) {}

        if (mounted) {
          AppFeedback.showError(context, errMsg);
        }
      }
    } catch (e) {
      if (mounted) {
        try {
          Navigator.of(context, rootNavigator: true).pop();
        } catch (_) {}
        AppFeedback.showError(context, 'Scanning error: $e');
      }
    }
  }

  void _applyReconciledAiRoster(Map<String, dynamic> reconciledData, {bool publishNow = false}) {
    final gate = reconciledData['gate'] as Map<String, dynamic>?;
    final matchedGateId = gate?['id'] as int?;
    if (matchedGateId != null && _selectedWeeklyGateId != matchedGateId) {
      _selectedWeeklyGateId = matchedGateId;
    }

    final weekStartStr = reconciledData['weekStartDate'] as String?;
    if (weekStartStr != null) {
      try {
        _weeklyStartDate = DateTime.parse(weekStartStr);
      } catch (_) {}
    }

    final staffRows = (reconciledData['staffRows'] as List?) ?? [];
    final days = (reconciledData['days'] as List?) ?? [];

    // Ensure current matrix list exists
    final currentMatrix = List<Map<String, dynamic>>.from(
      ((_weeklyRosterData?['matrix'] as List?) ?? []).map((m) => Map<String, dynamic>.from(m as Map))
    );

    for (final row in staffRows) {
      final matchedUser = row['matchedUser'] as Map<String, dynamic>?;
      if (matchedUser == null) continue;

      final userId = matchedUser['id'] as int;
      final uidStr = userId.toString();
      final schedule = (row['schedule'] as Map<String, dynamic>?) ?? {};

      // 1. Populate _weeklyDraft for all 7 days
      schedule.forEach((day, code) {
        _weeklyDraft['${uidStr}_$day'] = code.toString();
      });

      // 2. Ensure user is in matrix rows
      final existingIdx = currentMatrix.indexWhere((m) => m['userId'] == userId);
      final userScheduleMap = <String, dynamic>{};
      for (final d in days) {
        final dayName = d['dayOfWeek'] ?? '';
        final code = schedule[dayName] ?? '-';
        userScheduleMap[dayName] = {
          'shiftCode': code,
          'date': d['date'],
          'isOverride': true,
        };
      }

      if (existingIdx >= 0) {
        currentMatrix[existingIdx]['schedule'] = {
          ...((currentMatrix[existingIdx]['schedule'] as Map<String, dynamic>?) ?? {}),
          ...userScheduleMap,
        };
      } else {
        currentMatrix.add({
          'userId': userId,
          'fullName': matchedUser['fullName'] ?? row['rawName'] ?? 'Gateman',
          'employeeId': matchedUser['employeeId'] ?? '',
          'designation': matchedUser['designation'] ?? 'Gateman',
          'isRestkeeper': (matchedUser['role'] ?? '').toString().toLowerCase().contains('restkeeper'),
          'pmeStatus': matchedUser['pmeStatus'] ?? 'VALID',
          'rcStatus': matchedUser['rcStatus'] ?? 'VALID',
          'schedule': userScheduleMap,
        });
      }
    }

    if (_weeklyRosterData != null) {
      _weeklyRosterData!['matrix'] = currentMatrix;
      _weeklyRosterData!['weekStartDate'] = _formatDate(_weeklyStartDate);
    }

    setState(() {});

    if (publishNow) {
      _executePublishWeekly(mode: 'SPECIFIC_WEEK');
    } else {
      AppFeedback.showSuccess(
        context,
        'Physical roster chart applied to weekly matrix. Tap "Publish Roster" to finalize.',
      );
    }
  }

  Widget _buildWeeklyRosterView() {
    if (_isLoadingWeekly) {
      return const Center(child: CircularProgressIndicator());
    }

    final gate = _weeklyRosterData?['gate'] ?? {};
    final days = (_weeklyRosterData?['days'] as List?) ?? [];
    final matrix = (_weeklyRosterData?['matrix'] as List?) ?? [];

    final weekStartDateStr = _weeklyRosterData?['weekStartDate'] ?? _formatDate(_weeklyStartDate);
    final weekEndDateStr = _weeklyRosterData?['weekEndDate'] ?? '';

    return SingleChildScrollView(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 1. LC Gate Selector & Week Nav
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFCBD5E1)),
            ),
            child: Column(
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Row(
                      children: [
                        Icon(Icons.directions_railway, size: 18, color: AppColors.primary),
                        SizedBox(width: 6),
                        Text('Select LC Gate:', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                      ],
                    ),
                    if (_gates.isNotEmpty) ...[
                      Builder(builder: (context) {
                        final hasMatch = _gates.any((g) => g['id'] == _selectedWeeklyGateId);
                        final validId = hasMatch ? _selectedWeeklyGateId : (_gates[0]['id'] as int);
                        return DropdownButton<int>(
                          value: validId,
                          isDense: true,
                          underline: const SizedBox(),
                          items: _gates.map<DropdownMenuItem<int>>((g) {
                            final num = g['lcNumber'] ?? 'LC';
                            final loc = g['locationName'] ?? '';
                            return DropdownMenuItem<int>(
                              value: g['id'] as int,
                              child: Text(
                                loc.isNotEmpty ? '$num ($loc)' : num,
                                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: AppColors.primary),
                              ),
                            );
                          }).toList(),
                          onChanged: (val) {
                            if (val != null) {
                              setState(() => _selectedWeeklyGateId = val);
                              _loadWeeklyRosterData(gateId: val);
                            }
                          },
                        );
                      }),
                    ],
                  ],
                ),
                const Divider(height: 16),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    IconButton(
                      icon: const Icon(Icons.chevron_left_rounded),
                      onPressed: _previousWeek,
                      tooltip: 'Previous Week',
                    ),
                    InkWell(
                      onTap: _pickWeekStartDate,
                      child: Row(
                        children: [
                          const Icon(Icons.calendar_month_outlined, size: 16, color: AppColors.primary),
                          const SizedBox(width: 6),
                          Text(
                            'Week: $weekStartDateStr to $weekEndDateStr',
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5, color: Color(0xFF0F172A)),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.chevron_right_rounded),
                      onPressed: _nextWeek,
                      tooltip: 'Next Week',
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),

          // 2. AI Scan Physical Roster Card (Gemini 3.5 Flash)
          if (_canManageRoster) ...[
            Container(
              margin: const EdgeInsets.only(bottom: 14),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF0F172A), Color(0xFF1E293B)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(12),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.08),
                    blurRadius: 8,
                    offset: const Offset(0, 3),
                  ),
                ],
              ),
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: const Color(0xFF10B981).withValues(alpha: 0.2),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Icon(Icons.document_scanner_rounded, color: Color(0xFF10B981), size: 24),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Text(
                              'Scan Physical Roster Sheet',
                              style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13.5),
                            ),
                            const SizedBox(width: 6),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                              decoration: BoxDecoration(
                                color: const Color(0xFF10B981),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: const Text('Gemini AI', style: TextStyle(color: Colors.white, fontSize: 9.5, fontWeight: FontWeight.w800)),
                            ),
                          ],
                        ),
                        const SizedBox(height: 3),
                        Text(
                          'Auto-extract shifts & gatemen from PWI/CPWI duty charts',
                          style: TextStyle(color: Colors.white.withValues(alpha: 0.75), fontSize: 11),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 6),
                  ElevatedButton.icon(
                    onPressed: _openRosterScanPicker,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF10B981),
                      foregroundColor: Colors.white,
                      elevation: 0,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    icon: const Icon(Icons.camera_alt_outlined, size: 15),
                    label: const Text('Scan', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                  ),
                ],
              ),
            ),
          ],

          // Temporary Overrides Notice Banner
          if (_weeklyRosterData?['hasOverridesThisWeek'] == true) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFFFFFBEB),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFFDE68A)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.info_outline, size: 16, color: Color(0xFFB45309)),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text(
                      'Notice: This week contains specific date overrides. Other weeks automatically follow the Permanent Master Cycle.',
                      style: TextStyle(fontSize: 11.5, color: Color(0xFF92400E)),
                    ),
                  ),
                  if (_canManageRoster)
                    TextButton(
                      onPressed: () => _executePublishWeekly(mode: 'RESET'),
                      style: TextButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        minimumSize: const Size(0, 26),
                        visualDensity: VisualDensity.compact,
                      ),
                      child: const Text('Reset Week', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFFB45309))),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],

          // 2. Official Document Header Card (LC-91 Format)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFF94A3B8)),
              boxShadow: [
                BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 4, offset: const Offset(0, 2)),
              ],
            ),
            child: Column(
              children: [
                const Text(
                  'DUTY ROSTER',
                  style: TextStyle(fontWeight: FontWeight.w900, fontSize: 17, letterSpacing: 1.5, color: Color(0xFF0F172A)),
                ),
                const SizedBox(height: 2),
                Text(
                  'LC NO. - ${(gate['lcNumber']?.toString() ?? '91').replaceAll(RegExp(r'^(?:LC\s*[-–—:]?\s*)+', caseSensitive: false), '').trim()}',
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF1E3A8A)),
                ),
                if (gate['locationName'] != null)
                  Text(
                    '${gate['locationName']} • ${gate['stationName'] ?? ''}',
                    style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),

          // 3. Weekly Matrix Table
          if (matrix.isEmpty)
            Container(
              padding: const EdgeInsets.all(24),
              alignment: Alignment.center,
              child: const Text('No Gatemen or Restkeepers assigned to this LC Gate.'),
            )
          else
            Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFFCBD5E1)),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: DataTable(
                    columnSpacing: 14,
                    horizontalMargin: 12,
                    headingRowHeight: 46,
                    dataRowMinHeight: 52,
                    dataRowMaxHeight: 64,
                    headingRowColor: WidgetStateProperty.all(const Color(0xFFF1F5F9)),
                    columns: [
                      const DataColumn(
                        label: Text('Name', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A))),
                      ),
                      ...days.map((d) {
                        final name = d['dayOfWeek'].toString();
                        final dStr = (d['date'] as String).substring(5); // MM-DD
                        return DataColumn(
                          label: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFF0F172A))),
                              Text(dStr, style: const TextStyle(fontSize: 10, color: Color(0xFF64748B))),
                            ],
                          ),
                        );
                      }),
                    ],
                    rows: matrix.map((staff) {
                      final uid = staff['userId'].toString();
                      final fullName = staff['fullName'] ?? 'Staff';
                      final isRestkeeper = staff['isRestkeeper'] == true;

                      return DataRow(
                        cells: [
                          DataCell(
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Text(
                                  fullName,
                                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5, color: Color(0xFF0F172A)),
                                ),
                                Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                                      decoration: BoxDecoration(
                                        color: isRestkeeper ? const Color(0xFFFEF3C7) : const Color(0xFFEFF6FF),
                                        borderRadius: BorderRadius.circular(4),
                                      ),
                                      child: Text(
                                        (staff['designation'] != null && staff['designation'].toString().isNotEmpty)
                                            ? staff['designation'].toString()
                                            : ((staff['role'] is Map && staff['role']['name'] != null)
                                                ? staff['role']['name'].toString()
                                                : (isRestkeeper ? 'Restkeeper' : 'Gateman')),
                                        style: TextStyle(
                                          fontSize: 9.5,
                                          fontWeight: FontWeight.bold,
                                          color: isRestkeeper ? const Color(0xFFB45309) : const Color(0xFF1D4ED8),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                          ...days.map((d) {
                            final dayOfWeek = d['dayOfWeek'].toString();
                            final dateStr = d['date'].toString();
                            final code = _weeklyDraft['${uid}_$dayOfWeek'] ?? '-';

                            final colors = _getShiftColors(code);
                            final chipColor = colors['text']!;
                            final bgChipColor = colors['bg']!;

                            final cellData = (staff['schedule'] as Map<String, dynamic>?)?[dayOfWeek];
                            final isOverride = cellData?['isOverride'] == true;

                            return DataCell(
                              InkWell(
                                onTap: _canManageRoster
                                    ? () => _showShiftPickerSheet(staff['userId'], fullName, dayOfWeek, dateStr)
                                    : null,
                                borderRadius: BorderRadius.circular(6),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                                  decoration: BoxDecoration(
                                    color: isOverride ? const Color(0xFFFFFBEB) : bgChipColor,
                                    borderRadius: BorderRadius.circular(6),
                                    border: Border.all(color: isOverride ? const Color(0xFFD97706) : chipColor.withValues(alpha: 0.4), width: isOverride ? 1.5 : 1),
                                  ),
                                  child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Text(
                                            code,
                                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: isOverride ? const Color(0xFFB45309) : chipColor),
                                          ),
                                          if (isOverride) ...[
                                            const SizedBox(width: 3),
                                            Container(
                                              width: 5,
                                              height: 5,
                                              decoration: const BoxDecoration(color: Color(0xFFD97706), shape: BoxShape.circle),
                                            ),
                                          ],
                                        ],
                                      ),
                                      if (isOverride)
                                        const Text('Override', style: TextStyle(fontSize: 8.5, color: Color(0xFFD97706), fontWeight: FontWeight.bold))
                                      else if (_canManageRoster)
                                        const Icon(Icons.edit_note, size: 10, color: Color(0xFF94A3B8)),
                                    ],
                                  ),
                                ),
                              ),
                            );
                          }),
                        ],
                      );
                    }).toList(),
                  ),
                ),
              ),
            ),
          const SizedBox(height: 80),
        ],
      ),
    );
  }

  Widget _buildWeeklyPublishActionBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        boxShadow: [
          BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 10, offset: const Offset(0, -3)),
        ],
      ),
      child: SafeArea(
        child: Row(
          children: [
            Expanded(
              child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF1E3A8A),
                  padding: const EdgeInsets.symmetric(vertical: 13),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                ),
                icon: _isPublishingWeekly
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.verified_user_rounded, size: 18, color: Colors.white),
                label: Text(
                  _isPublishingWeekly ? 'Publishing Weekly Schedule...' : 'Publish Weekly Roster (SSE/P.WAY)',
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white),
                ),
                onPressed: _isPublishingWeekly ? null : _openPublishScopeDialog,
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Duty Roster & Shifts',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: Colors.white),
            ),
            InkWell(
              onTap: _stations.length > 1 ? _openStationSelectionDialog : null,
              borderRadius: BorderRadius.circular(4),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: Text(
                        _stationData != null ? '${_stationData!['name']} (${_stationData!['code']})' : 'Railway Station',
                        style: const TextStyle(fontSize: 11.5, color: Colors.white70),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (_stations.length > 1) ...[
                      const SizedBox(width: 4),
                      const Icon(Icons.arrow_drop_down, size: 16, color: Colors.white70),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
        backgroundColor: const Color(0xFF0D47A1),
        foregroundColor: Colors.white,
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          if (_stations.length > 1) ...[
            IconButton(
              icon: const Icon(Icons.location_on_outlined, color: Colors.white),
              tooltip: 'Switch Station',
              onPressed: _openStationSelectionDialog,
            ),
          ],
          if (_canManageRoster) ...[
            IconButton(
              icon: const Icon(Icons.document_scanner_rounded, color: Colors.white),
              tooltip: 'Scan Physical Roster (Gemini AI)',
              onPressed: _openRosterScanPicker,
            ),
            IconButton(
              icon: const Icon(Icons.tune_rounded, color: Colors.white),
              tooltip: 'Shift Timings Configurator',
              onPressed: _openShiftConfigDialog,
            ),
          ],
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white),
            tooltip: 'Refresh',
            onPressed: () {
              _loadRosterData();
              if (_isGateman) _loadMyShifts();
            },
          ),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: Colors.white,
          indicatorWeight: 3.0,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white60,
          labelStyle: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5),
          unselectedLabelStyle: const TextStyle(fontWeight: FontWeight.w500, fontSize: 13.5),
          tabs: _isDutyStaff
              ? [
                  Tab(text: 'My Shifts (${_myShifts.length})'),
                  const Tab(text: 'Weekly Gate Roster (Official)'),
                ]
              : [
                  Tab(text: 'Weekly Gate Roster (${_weeklyGateNumber.isNotEmpty ? _weeklyGateNumber : 'LC Gate'})'),
                  const Tab(text: 'Daily Station Matrix'),
                ],
        ),
      ),
      body: _isDutyStaff
          ? TabBarView(
              controller: _tabController,
              children: [
                _buildMyShiftsView(),
                _buildWeeklyRosterView(),
              ],
            )
          : TabBarView(
              controller: _tabController,
              children: [
                _buildWeeklyRosterView(),
                _buildRosterChartContent(),
              ],
            ),
      bottomNavigationBar: _canManageRoster && !_isDutyStaff
          ? (_tabController.index == 0 ? _buildWeeklyPublishActionBar() : _buildPublishActionBar())
          : null,
    );
  }

  Widget _buildPublishActionBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        boxShadow: [
          BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 10, offset: const Offset(0, -3)),
        ],
      ),
      child: SafeArea(
        child: Row(
          children: [
            Expanded(
              child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  padding: const EdgeInsets.symmetric(vertical: 13),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                ),
                icon: _isPublishing
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.send_rounded, size: 18, color: Colors.white),
                label: Text(
                  _isPublishing ? 'Publishing & Dispatching...' : 'Publish Roster & Notify Gatemen',
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white),
                ),
                onPressed: _isPublishing ? null : _publishRoster,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRosterChartContent() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_errorMessage.isNotEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.error_outline, size: 40, color: Colors.red),
              const SizedBox(height: 12),
              Text(_errorMessage, textAlign: TextAlign.center, style: const TextStyle(fontSize: 13)),
              const SizedBox(height: 16),
              ElevatedButton(onPressed: _loadRosterData, child: const Text('Try Again')),
            ],
          ),
        ),
      );
    }

    return SingleChildScrollView(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 1. Date Selector Bar
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFCBD5E1)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                IconButton(
                  icon: const Icon(Icons.chevron_left_rounded, size: 22),
                  onPressed: _previousDay,
                  tooltip: 'Previous Day',
                ),
                InkWell(
                  onTap: _pickDate,
                  child: Row(
                    children: [
                      const Icon(Icons.calendar_today_rounded, size: 16, color: AppColors.primary),
                      const SizedBox(width: 8),
                      Text(
                        _formatDisplayDate(_selectedDate),
                        style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.chevron_right_rounded, size: 22),
                  onPressed: _nextDay,
                  tooltip: 'Next Day',
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),

          // 2. Active Shifts Schedule Header Card
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: const Color(0xFFEFF6FF),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0xFFBFDBFE)),
            ),
            child: Row(
              children: [
                const Icon(Icons.schedule_rounded, color: Color(0xFF1D4ED8), size: 18),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '$_shiftConfigName (${_shifts.length} Shifts / Day)',
                    style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: Color(0xFF1E3A8A)),
                  ),
                ),
                if (_canManageRoster) ...[
                  TextButton(
                    style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: EdgeInsets.zero),
                    onPressed: _openShiftConfigDialog,
                    child: const Text('Change Timings', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8))),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 14),

          // 3. Gates List with Shift Allocations
          if (_gates.isEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 26),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFFE2E8F0)),
              ),
              child: Column(
                children: [
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF1F5F9),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.fence_outlined, size: 36, color: Color(0xFF64748B)),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'No LC Gates under ${_stationData != null ? '${_stationData!['name']} (${_stationData!['code']})' : 'this station'}.',
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF1E293B)),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'This station does not have any Level Crossing Gates registered under it in the database.',
                    style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 16),
                  if (_stations.any((s) => (s['_count']?['gates'] ?? 0) > 0)) ...[
                    ElevatedButton.icon(
                      icon: const Icon(Icons.swap_horiz_rounded, size: 18),
                      label: const Text('Switch to Station with Active Gates'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                      onPressed: () {
                        final stationWithGates = _stations.firstWhere(
                          (s) => (s['_count']?['gates'] ?? 0) > 0,
                          orElse: () => null,
                        );
                        if (stationWithGates != null) {
                          setState(() {
                            _stationId = stationWithGates['id'];
                            _stationData = stationWithGates;
                            _selectedWeeklyGateId = null;
                            _gates.clear();
                          });
                          _loadRosterData().then((_) {
                            if (_gates.isNotEmpty) {
                              _selectedWeeklyGateId = _gates[0]['id'] as int;
                              _loadWeeklyRosterData();
                            }
                          });
                        } else {
                          _openStationSelectionDialog();
                        }
                      },
                    ),
                  ] else if (_stations.length > 1) ...[
                    OutlinedButton.icon(
                      icon: const Icon(Icons.location_on_outlined, size: 18),
                      label: const Text('Select Another Station'),
                      onPressed: _openStationSelectionDialog,
                    ),
                  ],
                ],
              ),
            )
          else
            ..._gates.map((gate) {
              final gateId = gate['id'] as int;
              final lcNum = gate['lcNumber']?.toString() ?? 'Gate';
              final locName = gate['locationName']?.toString() ?? '';

              return Card(
                elevation: 1,
                margin: const EdgeInsets.only(bottom: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Gate Header
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.all(6),
                            decoration: BoxDecoration(
                              color: AppColors.primary.withValues(alpha: 0.1),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: const Icon(Icons.traffic_rounded, size: 18, color: AppColors.primary),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Gate ${lcNum.toUpperCase().startsWith('LC-') ? lcNum : 'LC-$lcNum'}',
                                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14.5, color: Color(0xFF0F172A)),
                                ),
                                if (locName.isNotEmpty)
                                  Text(locName, style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600)),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const Divider(height: 20),

                      // Shift Allocations for this Gate
                      ..._shifts.asMap().entries.map((shiftEntry) {
                        final shift = shiftEntry.value;
                        final shiftName = shift['name'].toString();
                        final startTime = shift['startTime'].toString();
                        final endTime = shift['endTime'].toString();
                        final key = '${gateId}_$shiftName';
                        final assignedGatemanId = _selectedAssignments[key];

                        // Find assigned gateman details if any
                        final assignedGm = _gatemen.firstWhere(
                          (gm) => gm['id'] == assignedGatemanId,
                          orElse: () => null,
                        );

                        final isExpired = assignedGm != null &&
                            (assignedGm['pmeStatus'] == 'EXPIRED' || assignedGm['rcStatus'] == 'EXPIRED');

                        return Container(
                          margin: const EdgeInsets.only(bottom: 10),
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: const Color(0xFFF8FAFC),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(
                              color: isExpired
                                  ? Colors.red.shade300
                                  : (assignedGm != null ? const Color(0xFF93C5FD) : const Color(0xFFE2E8F0)),
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
                                      const Icon(Icons.access_time_rounded, size: 14, color: AppColors.primary),
                                      const SizedBox(width: 4),
                                      Text(
                                        '$shiftName ($startTime - $endTime)',
                                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF1E293B)),
                                      ),
                                    ],
                                  ),
                                  if (assignedGm != null) ...[
                                    Row(
                                      children: [
                                        _buildExamBadge('PME', assignedGm['pmeStatus']),
                                        const SizedBox(width: 4),
                                        _buildExamBadge('RC', assignedGm['rcStatus']),
                                      ],
                                    ),
                                  ],
                                ],
                              ),
                              const SizedBox(height: 8),

                              // Gateman Selector Dropdown
                              DropdownButtonFormField<int?>(
                                initialValue: assignedGatemanId,
                                isExpanded: true,
                                decoration: const InputDecoration(
                                  isDense: true,
                                  border: OutlineInputBorder(),
                                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                ),
                                hint: const Text('Tap to assign Gateman for this shift', style: TextStyle(fontSize: 12, color: Colors.grey)),
                                items: [
                                  const DropdownMenuItem<int?>(
                                    value: null,
                                    child: Text('— Unassigned / Open Slot —', style: TextStyle(fontSize: 12, fontStyle: FontStyle.italic, color: Colors.grey)),
                                  ),
                                  ..._gatemen.map((gm) {
                                    final gmId = gm['id'] as int;
                                    final gmName = gm['fullName']?.toString() ?? 'Gateman';
                                    final gmPme = gm['pmeStatus']?.toString() ?? 'NOT_SET';
                                    final gmRc = gm['rcStatus']?.toString() ?? 'NOT_SET';

                                    final isPmeExp = gmPme == 'EXPIRED';
                                    final isRcExp = gmRc == 'EXPIRED';
                                    final isNonCompliant = isPmeExp || isRcExp;

                                    return DropdownMenuItem<int?>(
                                      value: gmId,
                                      child: Row(
                                        children: [
                                          Icon(
                                            isNonCompliant ? Icons.warning_amber_rounded : Icons.check_circle_outline,
                                            size: 14,
                                            color: isNonCompliant ? Colors.red : Colors.green,
                                          ),
                                          const SizedBox(width: 6),
                                          Expanded(
                                            child: Text(
                                              '$gmName${isNonCompliant ? ' (Exam Expired)' : ''}',
                                              style: TextStyle(
                                                fontSize: 12,
                                                fontWeight: FontWeight.w600,
                                                color: isNonCompliant ? Colors.red.shade900 : const Color(0xFF0F172A),
                                              ),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                        ],
                                      ),
                                    );
                                  }),
                                ],
                                onChanged: _canManageRoster
                                    ? (val) {
                                        setState(() {
                                          _selectedAssignments[key] = val;
                                        });
                                      }
                                    : null,
                              ),

                              if (isExpired) ...[
                                const SizedBox(height: 6),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                  decoration: BoxDecoration(color: Colors.red.shade50, borderRadius: BorderRadius.circular(4)),
                                  child: Row(
                                    children: [
                                      const Icon(Icons.warning_rounded, color: Colors.red, size: 13),
                                      const SizedBox(width: 4),
                                      Expanded(
                                        child: Text(
                                          'Safety Alert: Assigned Gateman has expired PME/RC medical qualification.',
                                          style: TextStyle(fontSize: 10.5, color: Colors.red.shade800, fontWeight: FontWeight.bold),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ],
                          ),
                        );
                      }),
                    ],
                  ),
                ),
              );
            }),
          const SizedBox(height: 70), // clearance for bottom action bar
        ],
      ),
    );
  }

  Widget _buildMyShiftsView() {
    if (_myShifts.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.event_available_outlined, size: 48, color: Colors.grey),
              const SizedBox(height: 12),
              const Text('No Upcoming Scheduled Duties', style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
              const SizedBox(height: 6),
              Text(
                'When your Restkeeper publishes your gate duty roster, your assigned shifts will appear here.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
              ),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('Refresh Duties'),
                onPressed: _loadMyShifts,
              ),
            ],
          ),
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(14),
      itemCount: _myShifts.length,
      itemBuilder: (ctx, idx) {
        final shift = _myShifts[idx];
        return Card(
          elevation: 1.5,
          margin: const EdgeInsets.only(bottom: 12),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(color: AppColors.primary, borderRadius: BorderRadius.circular(6)),
                      child: Text(
                        shift['gateNumber'] ?? 'LC Gate',
                        style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold),
                      ),
                    ),
                    Text(
                      shift['date'] ?? '',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  '${shift['shiftName']} (${shift['startTime']} - ${shift['endTime']})',
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF1E3A8A)),
                ),
                if (shift['locationName'] != null && shift['locationName'].toString().isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text('Location: ${shift['locationName']}', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                ],
                const Divider(height: 18),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Station: ${shift['stationName'] ?? 'Station'}', style: const TextStyle(fontSize: 11.5, color: Colors.grey)),
                    Text('By: ${shift['assignedBy'] ?? 'Restkeeper'}', style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: Color(0xFF0369A1))),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
