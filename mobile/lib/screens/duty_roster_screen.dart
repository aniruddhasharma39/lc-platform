import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';

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
        _selectedWeeklyGateId = _gates[0]['id'];
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

  void _openShiftConfigDialog() {
    final List<Map<String, String>> localShifts = _shifts.map((s) => {
      'id': (s['id'] ?? '').toString(),
      'name': (s['name'] ?? '').toString(),
      'startTime': (s['startTime'] ?? '').toString(),
      'endTime': (s['endTime'] ?? '').toString(),
    }).toList();

    String templateName = _shiftConfigName;

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
                  const SizedBox(height: 14),

                  // Quick Presets
                  const Text('Standard Presets:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 8),
                            side: BorderSide(color: localShifts.length == 3 ? AppColors.primary : Colors.grey.shade300),
                            backgroundColor: localShifts.length == 3 ? AppColors.primary.withValues(alpha: 0.08) : Colors.white,
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
                          child: const Text('3 Shifts (8 hrs)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 8),
                            side: BorderSide(color: localShifts.length == 2 ? AppColors.primary : Colors.grey.shade300),
                            backgroundColor: localShifts.length == 2 ? AppColors.primary.withValues(alpha: 0.08) : Colors.white,
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
                          child: const Text('2 Shifts (12 hrs)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
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
                        await _saveShiftConfig(templateName, localShifts);
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

  Future<void> _saveShiftConfig(String name, List<Map<String, String>> shifts) async {
    setState(() => _isLoading = true);
    try {
      final token = await _getToken();
      final body = {
        'stationId': _stationId,
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
          AppFeedback.showSuccess(context, 'Shift schedule updated successfully.');
        }
        _loadRosterData();
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

    final options = [
      {'code': '07-19', 'label': 'Day Shift (07:00 - 19:00)', 'desc': '12h Standard Day Duty', 'color': const Color(0xFF16A34A)},
      {'code': '19-24', 'label': 'Evening Shift (19:00 - 24:00)', 'desc': '5h Night Duty Part 1', 'color': const Color(0xFF4F46E5)},
      {'code': '00-07', 'label': 'Night Shift (00:00 - 07:00)', 'desc': '7h Night Duty Part 2', 'color': const Color(0xFF0284C7)},
      {'code': '00-07, 19-24', 'label': 'Split Shift (00-07 & 19-24)', 'desc': 'Continuous 24h Coverage Split', 'color': const Color(0xFF9333EA)},
      {'code': 'W/R', 'label': 'Weekly Rest (W/R)', 'desc': '30 Hours Mandatory Consecutive Rest', 'color': const Color(0xFFD97706)},
      {'code': 'N/R', 'label': 'Night Rest (N/R)', 'desc': 'Post-Night Shift Rest Period', 'color': const Color(0xFFEA580C)},
      {'code': '-', 'label': 'Relief / Off Duty (-)', 'desc': 'Covered by Restkeeper or Spare', 'color': const Color(0xFF64748B)},
    ];

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
                        color: color.withOpacity(0.12),
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

    for (final staff in matrix) {
      final uid = staff['userId'];
      for (final d in days) {
        final dayOfWeek = d['dayOfWeek'].toString();
        final dateStr = d['date'].toString();
        final code = _weeklyDraft['${uid}_$dayOfWeek'] ?? '-';

        String startTime = '07:00';
        String endTime = '19:00';
        bool isSplit = false;
        String? secStart;
        String? secEnd;

        if (code == '07-19') {
          startTime = '07:00';
          endTime = '19:00';
        } else if (code == '19-24') {
          startTime = '19:00';
          endTime = '24:00';
        } else if (code == '00-07') {
          startTime = '00:00';
          endTime = '07:00';
        } else if (code.contains('00-07') && code.contains('19-24')) {
          startTime = '00:00';
          endTime = '07:00';
          isSplit = true;
          secStart = '19:00';
          secEnd = '24:00';
        } else if (code == 'W/R' || code == 'N/R' || code == '-') {
          startTime = '00:00';
          endTime = '00:00';
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

    setState(() => _isPublishingWeekly = true);
    try {
      final token = await _getToken();
      final body = {
        'gateId': _selectedWeeklyGateId,
        'weekStartDate': _weeklyRosterData!['weekStartDate'],
        'mode': mode,
        'assignments': assignments,
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

  Widget _buildWeeklyRosterView() {
    if (_isLoadingWeekly) {
      return const Center(child: CircularProgressIndicator());
    }

    final gate = _weeklyRosterData?['gate'] ?? {};
    final days = (_weeklyRosterData?['days'] as List?) ?? [];
    final matrix = (_weeklyRosterData?['matrix'] as List?) ?? [];
    final signOff = _weeklyRosterData?['signOff'] ?? {};

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
                    if (_gates.isNotEmpty)
                      DropdownButton<int>(
                        value: _selectedWeeklyGateId,
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
                      ),
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
                BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 4, offset: const Offset(0, 2)),
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
                  'LC NO. - ${gate['lcNumber'] ?? '91'}',
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
                                        isRestkeeper ? 'Restkeeper' : 'Gateman',
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

                            Color chipColor = const Color(0xFF64748B);
                            Color bgChipColor = const Color(0xFFF1F5F9);

                            if (code == '07-19') {
                              chipColor = const Color(0xFF15803D);
                              bgChipColor = const Color(0xFFDCFCE7);
                            } else if (code == '19-24') {
                              chipColor = const Color(0xFF4338CA);
                              bgChipColor = const Color(0xFFEEF2FF);
                            } else if (code == '00-07') {
                              chipColor = const Color(0xFF0369A1);
                              bgChipColor = const Color(0xFFE0F2FE);
                            } else if (code.contains('00-07') && code.contains('19-24')) {
                              chipColor = const Color(0xFF7E22CE);
                              bgChipColor = const Color(0xFFF3E8FF);
                            } else if (code == 'W/R') {
                              chipColor = const Color(0xFFB45309);
                              bgChipColor = const Color(0xFFFEF3C7);
                            } else if (code == 'N/R') {
                              chipColor = const Color(0xFFC2410C);
                              bgChipColor = const Color(0xFFFFEDD5);
                            }

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
          const SizedBox(height: 14),

          // 4. Shift Legend Card
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFFF8FAFC),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            child: const Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Standard Shift Codes (24h Safety Coverage):', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11.5, color: Color(0xFF334155))),
                SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    Text('07-19: Day Shift (12h)', style: TextStyle(fontSize: 10.5, color: Color(0xFF15803D), fontWeight: FontWeight.w600)),
                    Text('19-24: Night Part 1 (5h)', style: TextStyle(fontSize: 10.5, color: Color(0xFF4338CA), fontWeight: FontWeight.w600)),
                    Text('00-07: Night Part 2 (7h)', style: TextStyle(fontSize: 10.5, color: Color(0xFF0369A1), fontWeight: FontWeight.w600)),
                    Text('W/R: Weekly Rest (30h)', style: TextStyle(fontSize: 10.5, color: Color(0xFFB45309), fontWeight: FontWeight.bold)),
                    Text('N/R: Night Rest', style: TextStyle(fontSize: 10.5, color: Color(0xFFC2410C), fontWeight: FontWeight.bold)),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),

          // 5. Official Stamps Footer (Matching Official Document)
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFCBD5E1)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(
                  children: [
                    Icon(Icons.verified, size: 16, color: Color(0xFF1E3A8A)),
                    SizedBox(width: 6),
                    Text('Official Indian Railways Sign-Off & Approvals', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFF0F172A))),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Prepared By (PWI / SSE)
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: const Color(0xFFEFF6FF),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFF93C5FD)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'वरिष्ठ सेक्शन इंजीनियर (रेलपथ-प्रभारी)',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 10, color: Color(0xFF1E3A8A)),
                            ),
                            const Text(
                              '(SSE/P.WAY/INCHARGE/KRD)',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 10, color: Color(0xFF1E3A8A)),
                            ),
                            const Text('CENTRAL RAILWAY (मध्य रेल)', style: TextStyle(fontSize: 9, color: Color(0xFF1E3A8A))),
                            const SizedBox(height: 6),
                            Text(
                              signOff['preparedByName'] ?? 'SSE / P.WAY Incharge',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: Color(0xFF0F172A)),
                            ),
                            const Text('Primary Author', style: TextStyle(fontSize: 9.5, color: Color(0xFF2563EB), fontWeight: FontWeight.bold)),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),

                    // Approved By (CPWI / ADEN Satara)
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFAF5FF),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFD8B4FE)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'सहायक मंडल इंजीनियर सातारा',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 10, color: Color(0xFF6B21A8)),
                            ),
                            const Text(
                              'Assistant Divisional Engineer STR',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 10, color: Color(0xFF6B21A8)),
                            ),
                            const Text('Central Railway STR (मध्य रेल)', style: TextStyle(fontSize: 9, color: Color(0xFF6B21A8))),
                            const SizedBox(height: 6),
                            Text(
                              signOff['approvedByName'] ?? 'ADEN / CPWI Section Incharge',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: Color(0xFF0F172A)),
                            ),
                            const Text('Section Incharge (Countersigned)', style: TextStyle(fontSize: 9.5, color: Color(0xFF9333EA), fontWeight: FontWeight.bold)),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ],
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
          BoxShadow(color: Colors.black.withOpacity(0.06), blurRadius: 10, offset: const Offset(0, -3)),
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
            Text(
              _stationData != null ? '${_stationData!['name']} (${_stationData!['code']})' : 'Railway Station',
              style: const TextStyle(fontSize: 11.5, color: Colors.white70),
            ),
          ],
        ),
        backgroundColor: const Color(0xFF0D47A1),
        foregroundColor: Colors.white,
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          if (_canManageRoster) ...[
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
                  const Tab(text: 'Weekly Gate Roster (LC-91)'),
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
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
              child: const Column(
                children: [
                  Icon(Icons.fence_outlined, size: 36, color: Colors.grey),
                  SizedBox(height: 10),
                  Text('No LC Gates under this station.', style: TextStyle(fontSize: 13, color: Colors.grey)),
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
                                Text('Gate LC-$lcNum', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14.5, color: Color(0xFF0F172A))),
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
                                value: assignedGatemanId,
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
